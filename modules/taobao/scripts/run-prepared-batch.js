const { fillBatch } = require('./fill-batch');
const { finalizeBatch } = require('./finalize-batch');

// Videos must already be uploaded and model choices prepared.
// The default completes all fields and stops before the publish click.
async function runPreparedBatch(page, choices, { publish = false } = {}) {
  // Snapshot renderer/model input so it cannot change while the page is being filled.
  choices = structuredClone(choices);
  await fillBatch(page, choices);
  return finalizeBatch(page, choices, { publish });
}
module.exports = { runPreparedBatch };
