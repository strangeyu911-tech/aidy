const { RESULT_CODES } = require("./result-codes");
const { createWindowsAppServer } = require("./windows-app-server");

function createPlatformAdapter({ platform = process.platform, ...dependencies } = {}) {
  if (platform === "win32") {
    return createWindowsAppServer(dependencies);
  }
  return {
    unsupported: true,
    code: RESULT_CODES.PLATFORM_UNSUPPORTED,
    platform,
  };
}

module.exports = { createPlatformAdapter };
