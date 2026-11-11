const { fillBatch } = require('./fill-batch');
const { finalizeBatch } = require('./finalize-batch');

// Videos must already be uploaded and model choices prepared.
// The default completes all fields and stops before the publish click.
async function runPreparedBatch(page, choices, { publish = false } = {}) {
  // Snapshot renderer/model input so it cannot change while the page is being filled.
  choices = structuredClone(choices);
  const filled=await fillBatch(page, choices);
  const failures=[...(filled.failures||[])];
  if(!filled.choices?.length)return {status:'no_success',clicked:false,verified:[],choices:[],failed:failures};
  const result=await finalizeBatch(page, filled.choices, { publish });
  return {...result,failed:[...failures,...(result.failed||[])]};
}
module.exports = { runPreparedBatch };
