// Validate the whole batch before touching the remote page.
function validateChoices(choices) {
  if (!Array.isArray(choices) || !choices.length || choices.length > 100)
    throw new Error('批次须包含 1 至 100 条视频');
  const seen = new Set();
  for (const item of choices) {
    if (!item || typeof item.file !== 'string' || !item.file.trim() || seen.has(item.file))
      throw new Error('批次包含无效或重复视频');
    seen.add(item.file);
    if (typeof item.caption !== 'string' || !item.caption.trim() || [...item.caption].length > 30)
      throw new Error('视频描述须为 1 至 30 字：' + item.file);
    if (!/^\d+$/.test(String(item.product_id || '')) ||
        typeof item.topic_title !== 'string' || !item.topic_title.trim())
      throw new Error('缺少有效商品 ID 或话题：' + item.file);
  }
  return choices;
}
module.exports = { validateChoices };
