const REFRESH_WORDS = /刷新|重新查|重新看|再看看|再看|重载|最新|refresh|reload|latest|newest/iu;
const ZHIJIANTIME_WORDS = /指尖时光|zhijian(?:time)?/iu;
const ITEM_WORDS = /日常|待办|任务|安排|计划|日程|todo|schedule/iu;
const MUTATION_WORDS = /新建|创建|添加|加了|修改|改了|更新|删除|删了|完成|完成了|打卡|签到|安排|调整|调了|改期|reschedule|create|update|delete|complete|check[- ]?in/iu;
const STANDALONE_MUTATION_WORDS = /打卡|签到|check[- ]?in/iu;

function decideZhijiantimeFreshness(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return { required: false, reason: "" };
  }

  if (REFRESH_WORDS.test(normalized) && (ZHIJIANTIME_WORDS.test(normalized) || ITEM_WORDS.test(normalized))) {
    return { required: true, reason: "explicit_refresh" };
  }

  if (MUTATION_WORDS.test(normalized)
    && (ZHIJIANTIME_WORDS.test(normalized) || ITEM_WORDS.test(normalized) || STANDALONE_MUTATION_WORDS.test(normalized))) {
    return { required: true, reason: "mutation_acknowledgement" };
  }

  return { required: false, reason: "" };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { decideZhijiantimeFreshness };
