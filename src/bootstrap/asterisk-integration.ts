import { randomUUID } from "node:crypto";
import { AsteriskAriClient, AsteriskRtpVoiceMediaGateway, AsteriskTelephonyGateway } from "../modules/telephony/index.js";

/** Only the API process enables PBX ingress; Voice Lab keeps its isolated transport. */
export function buildAsteriskIntegration(environment: NodeJS.ProcessEnv) {
  const fields = ["ASTERISK_ARI_URL", "ASTERISK_ARI_APPLICATION", "ASTERISK_ARI_USERNAME", "ASTERISK_ARI_PASSWORD"] as const;
  const values = fields.map(key => environment[key]?.trim());
  if (values.every(value => !value)) return undefined;
  if (values.some(value => !value)) throw new Error("All four ASTERISK_ARI connection settings are required together");
  const host = environment.YIBO_ASTERISK_MEDIA_HOST?.trim();
  if (!host) throw new Error("YIBO_ASTERISK_MEDIA_HOST is required");
  const start = Number(environment.YIBO_ASTERISK_MEDIA_PORT_START);
  const end = Number(environment.YIBO_ASTERISK_MEDIA_PORT_END);
  const client = new AsteriskAriClient({baseUrl:values[0]!,application:values[1]!,username:values[2]!,password:values[3]!});
  const voice = new AsteriskRtpVoiceMediaGateway(client,{host,portStart:start,portEnd:end});
  const allowExternalTransfer = ["1", "true", "enabled"].includes(
    (environment.YIBO_EXTERNAL_TRANSFER ?? "").trim().toLowerCase(),
  );
  const telephony = new AsteriskTelephonyGateway(client,()=>`call-${randomUUID()}`,voice,{
    allowExternalTransfer,
    calledNumberRegion: environment.YIBO_REGION?.trim(),
  });
  return {client,voice,telephony};
}
