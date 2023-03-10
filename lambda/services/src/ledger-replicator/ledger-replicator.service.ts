import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import axios from "axios";
import { Programme } from "../shared/entities/programme.entity";
import { dom } from "ion-js";
import { plainToClass } from "class-transformer";
import { ConfigService } from "@nestjs/config";
import { CreditOverall } from "../shared/entities/credit.overall.entity";
import { Company } from "../shared/entities/company.entity";
import { TxType } from "../shared/enum/txtype.enum";
import { add } from "winston";
import { response } from "express";

const computeChecksums = true;
const REVISION_DETAILS = "REVISION_DETAILS";
const deagg = require("aws-kinesis-agg");

@Injectable()
export class LedgerReplicatorService {
  constructor(
    @InjectRepository(Programme) private programmeRepo: Repository<Programme>,
    @InjectRepository(Company) private companyRepo: Repository<Company>,
    private logger: Logger,
    private configService: ConfigService
  ) {}

  async forwardGeocoding(address: any[]) {
    console.log("addresses passed to forwardGeocoding function -> ", address);
    let geoCodinates: any[] = [];
    const ACCESS_TOKEN =
      "pk.eyJ1IjoicGFsaW5kYSIsImEiOiJjbGMyNTdqcWEwZHBoM3FxdHhlYTN4ZmF6In0.KBvFaMTjzzvoRCr1Z1dN_g";

    for (let index = 0; index < address.length; index++) {
      const url =
        "https://api.mapbox.com/geocoding/v5/mapbox.places/" +
        encodeURIComponent(address[index]) +
        ".json?access_token=" +
        ACCESS_TOKEN +
        "&limit=1"+ 
        `&country=${this.configService.get('systemCountry')}&autocomplete=false&types=region%2Cdistrict`
      console.log("geocoding request urls -> ", index, url);
      await axios
        .get(url)
        .then(function (response) {
          // handle success
          console.log(
            "cordinates data in replicator -> ",
            response?.data?.features[0],
            response?.data?.features[0]?.center
          );
          if (response?.data?.features.length > 0) {
            geoCodinates.push([...response?.data?.features[0]?.center]);
          } else {
            geoCodinates.push(null)
          }
        })
        .catch((err) => {
          this.logger.error("Geocoding failed - ", err);
          return err;
        });
    }

    return geoCodinates;
  }

  async processRecords(records) {
    return await Promise.all(
      records.map(async (record) => {
        // Kinesis data is base64 encoded so decode here
        const payload = Buffer.from(record.data, "base64");

        // payload is the actual ion binary record published by QLDB to the stream
        const ionRecord = dom.load(payload);
        // Only process records where the record type is REVISION_DETAILS
        if (ionRecord.get("recordType").stringValue() !== REVISION_DETAILS) {
          this.logger.log(
            `Skipping record of type ${ionRecord
              .get("recordType")
              .stringValue()}`
          );
        } else {
          this.logger.log("ION Record", JSON.stringify(ionRecord));

          const tableName = ionRecord
            .get("payload")
            .get("tableInfo")
            .get("tableName");
          if (tableName == this.configService.get("ledger.table")) {
            const payload = ionRecord
              .get("payload")
              .get("revision")
              .get("data");

            const programme: Programme = plainToClass(
              Programme,
              JSON.parse(JSON.stringify(payload))
            );
            try {
              let address: any[] = [];
              if (programme && programme.programmeProperties) {
                if (programme.currentStage === "AwaitingAuthorization") {
                  const programmeProperties = programme.programmeProperties;
                  if (programmeProperties.geographicalLocation) {
                    for (
                      let index = 0;
                      index < programmeProperties.geographicalLocation.length;
                      index++
                    ) {
                      address.push(
                        programmeProperties.geographicalLocation[index]
                      );
                    }
                  }
                  await this.forwardGeocoding([...address]).then(
                    (response: any) => {
                      console.log(
                        "response from forwardGeoCoding function -> ",
                        response
                      );
                      programme.geographicalLocationCordintes = [...response];
                    }
                  );
                }
              }
            } catch (error) {
              console.log(
                "Getting cordinates with forward geocoding failed -> ",
                error
              );
            } finally {
              programme.updatedAt = new Date(programme.txTime)
              programme.createdAt = new Date(programme.createdTime)
              const columns =
                this.programmeRepo.manager.connection.getMetadata(
                  "Programme"
                ).columns;
              const columnNames = columns
                .filter(function (item) {
                  return (item.propertyName !== "programmeId" && item.propertyName !== "geographicalLocationCordintes");
                })
                .map((e) => e.propertyName);
              
              this.logger.debug(`${columnNames} ${JSON.stringify(programme)}`);
              return await this.programmeRepo
                .createQueryBuilder()
                .insert()
                .values(programme)
                .orUpdate(columnNames, ["programmeId"])
                .execute();
            }
          } else if (
            tableName == this.configService.get("ledger.companyTable")
          ) {
            const payload = ionRecord
              .get("payload")
              .get("revision")
              .get("data");

            const overall: CreditOverall = plainToClass(
              CreditOverall,
              JSON.parse(JSON.stringify(payload))
            );
            const parts = overall.txId.split("#");
            const companyId = parseInt(parts[0]);
            let account;
            if (parts.length > 1) {
              account = parts[1];
            }
            const company = await this.companyRepo.findOneBy({
              companyId: companyId,
            });

            const meta = JSON.parse(
              JSON.stringify(
                ionRecord.get("payload").get("revision").get("metadata")
              )
            );

            if (company && meta["version"]) {
              if (company.lastUpdateVersion >= parseInt(meta["version"])) {
                return;
              }
            }

            let updateObj;
            if (account) {
              if (company.secondaryAccountBalance) {
                company.secondaryAccountBalance[account]["total"] =
                  overall.credit;
                company.secondaryAccountBalance[account]["count"] += 1;
              } else {
                company.secondaryAccountBalance = {
                  account: { total: overall.credit, count: 1 },
                };
              }

              updateObj = {
                secondaryAccountBalance: company.secondaryAccountBalance,
                lastUpdateVersion: parseInt(meta["version"]),
              };
            } else {
              updateObj = {
                creditBalance: overall.credit,
                programmeCount:
                  Number(company.programmeCount) +
                  (overall.txType == TxType.AUTH ? 1 : 0),
                lastUpdateVersion: parseInt(meta["version"]),
              };
            }

            const response = await this.companyRepo
              .update(
                {
                  companyId: parseInt(overall.txId),
                },
                updateObj
              )
              .catch((err: any) => {
                this.logger.error(err);
                return err;
              });
          }
        }
      })
    );
  }

  async promiseDeaggregate(record) {
    return new Promise((resolve, reject) => {
      deagg.deaggregateSync(record, computeChecksums, (err, responseObject) => {
        if (err) {
          //handle/report error
          return reject(err);
        }
        return resolve(responseObject);
      });
    });
  }

  async replicate(event): Promise<any> {
    this.logger.log("Event received", JSON.stringify(event));
    return await Promise.all(
      event.Records.map(async (kinesisRecord) => {
        const records = await this.promiseDeaggregate(kinesisRecord.kinesis);
        return await this.processRecords(records);
      })
    );
  }
}
