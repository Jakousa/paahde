// Tells the page which game server to talk to (src/desktop.ts). Empty when the page was loaded from the server
// itself (--remote): then its own address is the server, as in a browser.
const { contextBridge } = require('electron');

const server = process.argv.find((a) => a.startsWith('--paahde-server='))?.slice(16);
if (server) contextBridge.exposeInMainWorld('desktop', { server });
