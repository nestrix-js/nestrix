// Creates the spike's Kafka topics from the host: `node test/kafka-topics.mjs <port>`.
// The in-container CLI cannot reach the broker's advertised host port.
import { Kafka } from "kafkajs";

const admin = new Kafka({
  brokers: [`127.0.0.1:${process.argv[2]}`],
  logLevel: 0,
}).admin();
await admin.connect();
const topics = ["sum", "sum.reply", "evt", "stream", "fail", "slow", "guarded"];
console.log(
  "created",
  await admin.createTopics({
    waitForLeaders: true,
    topics: topics.map((topic) => ({ topic, numPartitions: 1 })),
  }),
);
console.log(await admin.listTopics());
await admin.disconnect();
