import { builtInScenarios, RATE_CARD_AS_OF } from "../launch/cost-model.js";

const scenarios = builtInScenarios();
process.stdout.write(`${JSON.stringify({ asOf: RATE_CARD_AS_OF, currency: "USD", scenarios }, null, 2)}\n`);
