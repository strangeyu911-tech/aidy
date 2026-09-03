"use strict";

const BRAND = Object.freeze({
  english: "Aidy",
  chinese: "艾迪",
  legacyEnglish: "CyberBoss",
  executableName: "Aidy.exe",
  legacyAppId: "com.cyberboss.desktop",
  legacyAppUserModelId: "CyberBoss.Desktop",
  legacyUserDataDirectory: "CyberBoss",
});

function configureElectronBranding(electronApp, pathModule, argv = []) {
  electronApp.setName(BRAND.english);
  // Keep Chromium's persisted profile in the existing directory. Changing the
  // visible product name must not create a blank profile or lose login state.
  if (!argv.some((value) => /^--user-data-dir(?:=|$)/i.test(String(value)))) {
    electronApp.setPath(
      "userData",
      pathModule.join(electronApp.getPath("appData"), BRAND.legacyUserDataDirectory),
    );
  }
  // Keep the Windows identity stable so upgrades, notifications, and taskbar
  // grouping remain associated with existing CyberBoss installations.
  electronApp.setAppUserModelId(BRAND.legacyAppUserModelId);
}

module.exports = { BRAND, configureElectronBranding };
