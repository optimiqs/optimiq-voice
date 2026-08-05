#!/usr/bin/env node

import { NODE_ENV, SKIP_IDENTITY } from "./envs";
import { startVoiceServer } from "./voiceServerSetup";

const skipIdentity = NODE_ENV === "development" || SKIP_IDENTITY;

startVoiceServer(skipIdentity);
