import Client, {
  CommitmentLevel,
  SubscribeRequest,
  SubscribeUpdate,
} from "@triton-one/yellowstone-grpc";
import {
  DriftClient,
  DriftEnv,
  EventType,
  ResubOpts,
  Wallet,
} from "@drift-labs/sdk";
import { ClientDuplexStream } from "@grpc/grpc-js";
import { Connection, Keypair } from "@solana/web3.js";
import { parseLogsWithRaw } from "@drift-labs/sdk";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { getSerializerFromEventType } from "./utils/utils";
import { RedisClient } from "@drift/common/clients";

require("dotenv").config();

type grpcEventsSubscriberConfig = {
  programId: string;
  endpoint: string;
  token: string;
  resubOpts: ResubOpts;
};

const driftEnv = (process.env.ENV || "devnet") as DriftEnv;
const endpoint = process.env.GRPC_ENDPOINT;
if (!endpoint) {
  throw new Error("Missing GRPC_ENDPOINT");
}
const token = process.env.TOKEN;
const resubTimeout = process.env.RESUB_TIMEOUT_MS || 5_000;

export class GrpcEventSubscriber {
  config: grpcEventsSubscriberConfig;
  driftClient: DriftClient;
  stream?: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>;
  mostRecentSlot: number = -1;

  timeoutId?: NodeJS.Timeout;
  isUnsubscribing = false;
  receivingData: boolean;
  redisClient: RedisClient;

  constructor(driftClient: DriftClient, config: grpcEventsSubscriberConfig) {
    this.driftClient = driftClient;
    this.config = config;
  }

  async init(): Promise<void> {
    const redis = new RedisClient({});
    await redis.connect();
    this.redisClient = redis;
  }

  public async subscribe(): Promise<void> {
    const client = new Client(this.config.endpoint, this.config.token, {});
    this.stream = await client.subscribe();
    const request: SubscribeRequest = {
      slots: {},
      accounts: {},
      transactions: {
        drift: {
          vote: false,
          failed: false,
          accountInclude: [this.config.programId],
          accountExclude: [],
          accountRequired: [],
        },
      },
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.CONFIRMED,
      entry: {},
      transactionsStatus: {},
    };

    this.stream.on("data", (chunk: any) => {
      if (!chunk.transaction) {
        return;
      }

      if (this.config.resubOpts.resubTimeoutMs) {
        this.receivingData = true;
        clearTimeout(this.timeoutId!);
      }

      const slot = Number(chunk.transaction.slot);
      if (slot > this.mostRecentSlot) this.mostRecentSlot = slot;
      const logs = chunk.transaction.transaction.meta.logMessages;
      const { events, rawLogs } = parseLogsWithRaw(
        this.driftClient.program,
        logs,
      );
      const txSig = bs58.encode(chunk.transaction.transaction.signature);

      let runningEventIndex = 0;
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const rawLog = rawLogs[i];

        // @ts-ignore
        event.data.txSig = txSig;
        event.data.slot = slot;
        event.data.eventType = event.name;
        event.data.txSigIndex = runningEventIndex;

        const eventType = event.name as EventType;
        if (eventType === "SignedMsgOrderRecord") {
          const hash = event.data.hash;
          console.log(`SignedMsgOrderRecord hash: ${hash}`);
          this.redisClient.setExpiring(
            `swift-hashes::${hash}`,
            event.data.userOrderId,
            60 * 3,
          );
          continue;
        }

        const serializer = getSerializerFromEventType(eventType);
        if (serializer) {
          const serialized = serializer(event.data);
          serialized.rawLog = rawLog;
          this.redisClient.publish(event.name, serialized);
        }
        runningEventIndex++;
      }

      if (this.config.resubOpts.resubTimeoutMs) {
        this.setTimeout();
      }
    });

    return new Promise<void>((resolve, reject) => {
      this.stream!.write(request, (err: Error) => {
        if (err === null || err === undefined) {
          resolve();
        } else {
          reject(err);
        }
      });
    }).catch((reason) => {
      console.error(reason);
      throw reason;
    });
  }

  protected setTimeout(): void {
    this.timeoutId = setTimeout(async () => {
      if (this.isUnsubscribing) {
        return;
      }

      if (this.receivingData) {
        if (this.config.resubOpts.logResubMessages) {
          console.log(
            `No program logs in ${this.config.resubOpts.resubTimeoutMs}ms. Resubscribing...`,
          );
        }
        await this.unsubscribe(true);
        this.receivingData = false;
        await this.subscribe();
      }
    }, this.config.resubOpts?.resubTimeoutMs);
  }

  async unsubscribe(onResub = false): Promise<void> {
    if (!onResub) {
      this.config.resubOpts.resubTimeoutMs = undefined;
    }
    this.isUnsubscribing = true;
    clearTimeout(this.timeoutId);
    this.timeoutId = undefined;

    if (this.stream != null) {
      const promise = new Promise<void>((resolve, reject) => {
        const request: SubscribeRequest = {
          slots: {},
          accounts: {},
          transactions: {},
          blocks: {},
          blocksMeta: {},
          accountsDataSlice: [],
          entry: {},
          transactionsStatus: {},
        };
        this.stream.write(request, (err) => {
          if (err === null || err === undefined) {
            this.stream = undefined;
            this.isUnsubscribing = false;
            resolve();
          } else {
            reject(err);
          }
        });
      }).catch((reason) => {
        console.error(reason);
        throw reason;
      });
      return promise;
    } else {
      this.isUnsubscribing = false;
    }
  }
}

async function main() {
  const driftClient = new DriftClient({
    env: driftEnv,
    connection: new Connection(endpoint!),
    wallet: new Wallet(new Keypair()),
  });
  const eventSubscriber = new GrpcEventSubscriber(driftClient, {
    programId: driftClient.program.programId.toString(),
    endpoint: endpoint!,
    token: token!,
    resubOpts: {
      resubTimeoutMs: Number(resubTimeout),
      logResubMessages: process.env.LOG_RESUB_MESSAGES === "true",
    },
  });
  await eventSubscriber.init();
  await eventSubscriber.subscribe();
}

main();
