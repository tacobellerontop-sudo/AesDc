const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("DiscordNative", { isFake: true });
