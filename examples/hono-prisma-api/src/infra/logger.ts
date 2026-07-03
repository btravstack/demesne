// Infrastructure — a console logger implementing the Logger port. Ready, cannot fail.

import { Layer } from "demesne";

import { Logger } from "../application/ports.js";

export const LoggerLive = Layer.value(Logger, { info: (msg) => console.log(`[info] ${msg}`) });
