(function () {
  function getClientPlatform() {
    const platform = navigator.platform ?? "";
    const userAgent = navigator.userAgent ?? "";
    const value = `${platform} ${userAgent}`;

    if (/\bwin/i.test(value) || /windows/i.test(value)) {
      return "windows";
    }

    if (/mac/i.test(value)) {
      return "macos";
    }

    if (/linux|x11|unix|bsd/i.test(value)) {
      return "unix";
    }

    return "unknown";
  }

  window.__PI_DEV__ = window.__PI_DEV__ ?? {};
  window.__PI_DEV__.getClientPlatform = getClientPlatform;
})();
