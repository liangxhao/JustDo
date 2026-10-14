import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from 'vitest';

const runtime = path.resolve(
  process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ?? 'vendor/openclaw-runtime/current',
);
const pluginDir = path.join(runtime, 'dist/extensions/openai');

test.skipIf(!fs.existsSync(path.join(pluginDir, 'native-index.mjs')))(
  'native OpenAI registration and cold catalog share isolated endpoints and native transcript ordering',
  () => {
    const script = `
      import { registerHooks } from 'node:module';
      import fs from 'node:fs';
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      import assert from 'node:assert/strict';
      const runtime = ${JSON.stringify(runtime)};
      const packageExports = JSON.parse(fs.readFileSync(path.join(runtime,'package.json'),'utf8')).exports;
      // The native plugin loader supplies SDK aliases for cold .setup chunks.
      // Resolve the exact package export here while retaining native module URLs.
      registerHooks({resolve(specifier,context,next){
        if (!specifier.startsWith('openclaw/plugin-sdk/')) return next(specifier,context);
        const exported = packageExports['./'+specifier.slice('openclaw/'.length)];
        const entry = typeof exported==='string' ? exported : exported?.default;
        assert.ok(entry,specifier);
        return {shortCircuit:true,url:pathToFileURL(path.join(runtime,entry)).href};
      }});
      const {default:plugin} = await import(${JSON.stringify(pathToFileURL(path.join(pluginDir, 'index.js')).href)});
      const {default:catalog} = await import(${JSON.stringify(pathToFileURL(path.join(pluginDir, 'capability-catalog.js')).href)});
      const registrations = new Map();
      const api = {registrationMode:'discovery', runtime:{modelAuth:{
        ensureAuthProfileStore(){},listProfilesForProvider(){return [];},isProviderApiKeyConfigured(){return false;}
      }}};
      for (const key of ['registerProvider','registerEmbeddingProvider','registerImageGenerationProvider',
        'registerRealtimeTranscriptionProvider','registerRealtimeVoiceProvider','registerSpeechProvider','registerMediaUnderstandingProvider'])
        api[key] = entry => {const entries=registrations.get(key)??[]; entries.push(entry);registrations.set(key,entries);};
      plugin.register(api);
      for (const entries of registrations.values()) assert.equal(entries.length,1);
      assert.equal(plugin.id,'openai');
      assert.equal(registrations.get('registerProvider')[0].id,'openai');
      const options=[];
      const headerRequests=[];
      const context={
        createRealtimeTranscriptionWebSocketSession(request){options.push(request);return {};},
        resolveProviderRequestHeaders(request){headerRequests.push(request);return request.defaultHeaders;},
      };
      const registered=registrations.get('registerRealtimeTranscriptionProvider')[0](context);
      const discovered=catalog(context).realtimeTranscriptionProviders.find(provider=>provider.id==='openai');
      const config=registered.resolveConfig({cfg:{},rawConfig:{providers:{openai:{baseUrl:'https://first.example/v1/',apiKey:'synthetic',model:'native-model'}}}});
      assert.equal(config.model,'native-model');
      assert.equal(config.baseUrl,'https://first.example/v1/');
      const transcripts=[];
      registered.createSession({providerConfig:config,onTranscript:text=>transcripts.push(text)});
      discovered.createSession({providerConfig:{baseUrl:'http://second.example/v1',apiKey:'synthetic'}});
      registered.createSession({providerConfig:{apiKey:'synthetic'}});
      await Promise.all(options.map(request=>request.headers()));
      assert.deepEqual(options.map(request=>request.url),[
        'wss://first.example/v1/realtime?intent=transcription',
        'ws://second.example/v1/realtime?intent=transcription',
        'wss://api.openai.com/v1/realtime?intent=transcription',
      ]);
      assert.deepEqual(headerRequests.map(request=>request.baseUrl),options.map(request=>request.url));
      assert.ok(options.every(request=>request.maxReconnectAttempts===5));
      const transport={closeNow(){throw new Error('unexpected failure');}};
      options[0].onMessage({type:'input_audio_buffer.committed',item_id:'first'},transport);
      options[0].onMessage({type:'input_audio_buffer.committed',item_id:'second',previous_item_id:'first'},transport);
      options[0].onMessage({type:'conversation.item.input_audio_transcription.completed',item_id:'second',transcript:'two'},transport);
      assert.deepEqual(transcripts,[]);
      options[0].onMessage({type:'conversation.item.input_audio_transcription.completed',item_id:'first',transcript:'one'},transport);
      assert.deepEqual(transcripts,['one','two']);
      console.log('native-composition-ok');
    `;
    expect(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      }),
    ).toContain('native-composition-ok');
  },
  35_000,
);
