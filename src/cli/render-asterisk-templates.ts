import { resolve } from "node:path";
import { renderAsteriskTemplates } from "../launch/asterisk-templates.js";

const destination = resolve("deploy/asterisk/rendered");
renderAsteriskTemplates(resolve("deploy/asterisk"), destination, {
  YIBO_PUBLIC_IP: process.env.YIBO_PUBLIC_IP?.trim() || "127.0.0.1",
  YIBO_TEST_EXTENSION_PASSWORD: process.env.YIBO_TEST_EXTENSION_PASSWORD?.trim() || "change-me-lab-only",
  YIBO_ARI_PASSWORD: process.env.YIBO_ARI_PASSWORD?.trim() || "change-me-ari",
  YIBO_LAB_DID: process.env.YIBO_LAB_DID?.trim() || "+15555550100",
});
process.stdout.write(`Rendered Asterisk config to ${destination}\n`);
process.stdout.write("Rendered files are local only. Do not commit them.\n");
