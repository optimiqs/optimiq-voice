#!/usr/bin/env node

import { AUTH_URL, SKIP_TOKEN_VERIFICATION } from "./envs";
import { startVoiceServer } from "./voiceServerSetup";

startVoiceServer({ authUrl: AUTH_URL, skipTokenVerification: SKIP_TOKEN_VERIFICATION });
