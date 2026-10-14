import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { buildSync } from 'esbuild';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, onTestFinished, test } from 'vitest';

const runtime = path.resolve(
  process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ?? 'vendor/openclaw-runtime/current',
);

const modes = ['source'];
const runtimePlugin = path.join(runtime, 'dist/extensions/openai');
if (
  fs.existsSync(path.join(runtimePlugin, 'package.json')) &&
  JSON.parse(fs.readFileSync(path.join(runtimePlugin, 'package.json'), 'utf8')).openclaw
    ?.runtimeBundled === true
)
  modes.push('artifact');

test.skipIf(!fs.existsSync(path.join(runtime, 'package.json'))).each(modes)(
  'OpenAI %s registration and cold catalog share isolated endpoints and native transcript ordering',
  mode => {
    const compiled =
      mode === 'artifact'
        ? runtimePlugin
        : fs.mkdtempSync(path.join(os.tmpdir(), 'provider-source-'));
    if (mode === 'source') {
      onTestFinished(() => fs.rmSync(compiled, { recursive: true, force: true }));
      for (const name of [
        'index',
        'capability-catalog',
        'setup-api',
        'provider-policy-api',
        'provider-contract-api',
      ])
        buildSync({
          entryPoints: [path.resolve('openclaw-extensions/openai', name + '.ts')],
          outfile: path.join(compiled, name + '.js'),
          bundle: true,
          packages: 'external',
          platform: 'node',
          format: 'esm',
          target: 'node24',
        });
      fs.writeFileSync(path.join(compiled, 'package.json'), '{"type":"module"}');
    } else {
      const metadata = JSON.parse(fs.readFileSync(path.join(compiled, 'package.json'), 'utf8'));
      expect(metadata.openclaw.extensions).toEqual(['./index.js']);
      for (const worker of metadata.openclaw.build.workerEntries)
        expect(fs.existsSync(path.join(compiled, worker))).toBe(true);
      expect(fs.existsSync(path.join(compiled, 'native-index.mjs'))).toBe(false);
      expect(fs.existsSync(path.join(runtime, 'dist/extensions/video-openai'))).toBe(false);
    }
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
      const {default:plugin} = await import(${JSON.stringify(pathToFileURL(path.join(compiled, 'index.js')).href)});
      const {default:catalog} = await import(${JSON.stringify(pathToFileURL(path.join(compiled, 'capability-catalog.js')).href)});
      const registrations = new Map();
      const api = {registrationMode:'discovery', runtime:{modelAuth:{
        ensureAuthProfileStore(){},listProfilesForProvider(){return [];},isProviderApiKeyConfigured(){return false;}
      }}};
      for (const key of ['registerProvider','registerEmbeddingProvider','registerImageGenerationProvider',
        'registerRealtimeTranscriptionProvider','registerVideoGenerationProvider','registerSpeechProvider','registerMediaUnderstandingProvider'])
        api[key] = entry => {const entries=registrations.get(key)??[]; entries.push(entry);registrations.set(key,entries);};
      plugin.register(api);
      for (const entries of registrations.values()) assert.equal(entries.length,1);
      assert.equal(plugin.id,'openai');
      assert.equal(registrations.get('registerProvider')[0].id,'openai');
      const modelProvider=registrations.get('registerProvider')[0];
      assert.deepEqual(modelProvider.auth,[]);
      assert.deepEqual(modelProvider.envVars,[]);
      assert.equal(modelProvider.catalog,undefined);
      assert.ok(modelProvider.resolveThinkingProfile({provider:'openai',modelId:'gpt-6-astra',agentRuntime:'openclaw',api:'openai-responses'}).levels.some(level=>level.id==='max'));
      const modelConfig={models:{providers:{openai:{baseUrl:'http://chat.lan/v1',api:'openai-completions',models:[{id:'selected',baseUrl:'http://model.lan/v2',api:'openai-responses'}]}}}};
      assert.deepEqual(modelProvider.normalizeTransport({provider:'openai',modelId:'selected',api:'openai-completions',baseUrl:'https://api.openai.com/v1',config:modelConfig}),{api:'openai-responses',baseUrl:'http://model.lan/v2'});
      assert.throws(()=>modelProvider.normalizeTransport({provider:'openai',baseUrl:'https://api.openai.com/v1'}),/service URL is required/);
      const setup=await import(${JSON.stringify(pathToFileURL(path.join(compiled, 'setup-api.js')).href)});
      assert.deepEqual(setup.buildOpenAISetupProvider().auth,[]);
      const contract=await import(${JSON.stringify(pathToFileURL(path.join(compiled, 'provider-contract-api.js')).href)});
      assert.deepEqual(contract.createOpenAIProvider().auth,[]);
      const policy=await import(${JSON.stringify(pathToFileURL(path.join(compiled, 'provider-policy-api.js')).href)});
      assert.equal(policy.resolveModelRoutes({provider:'openai',modelId:'gpt-6-astra',env:{OPENAI_BASE_URL:'https://api.openai.com/v1'}}).kind,'incompatible');
      assert.equal(registrations.get('registerVideoGenerationProvider')[0].id,'video-openai');
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
      process.env.OPENAI_API_KEY='synthetic-public-key';
      assert.equal(registered.isConfigured({providerConfig:{apiKey:'synthetic'}}),false);
      const transcripts=[];
      registered.createSession({providerConfig:config,onTranscript:text=>transcripts.push(text)});
      discovered.createSession({providerConfig:{baseUrl:'ws://second.example/v1',apiKey:'synthetic'}});
      assert.throws(()=>registered.createSession({providerConfig:{apiKey:'synthetic'}}),/service URL is required/);
      await Promise.all(options.map(request=>request.headers()));
      assert.deepEqual(options.map(request=>request.url),[
        'wss://first.example/v1/realtime?intent=transcription',
        'ws://second.example/v1/realtime?intent=transcription',
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
      const speech=registrations.get('registerSpeechProvider')[0];
      const emptySpeech=speech.resolveConfig({rawConfig:{}});
      assert.equal(speech.isConfigured({providerConfig:emptySpeech}),false);
      assert.equal(emptySpeech.baseUrl,'');
      await assert.rejects(speech.synthesize({providerConfig:emptySpeech,text:'synthetic',target:'audio-file',cfg:{},timeoutMs:1000}),/service URL is required/);
      const {createServer}=await import('node:http');
      const requests=[];
      const server=createServer(async(req,res)=>{
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        requests.push({path:req.url,auth:req.headers.authorization,body:Buffer.concat(chunks).toString()});
        if(req.url==='/image/v1/images/generations'||req.url==='/image/v1/images/edits'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{b64_json:Buffer.from('synthetic-image').toString('base64')}]}));}
        else if(req.url==='/speech/v1/audio/speech'){res.setHeader('content-type','audio/wav');res.end(Buffer.from('RIFFsyntheticWAVE'));}
        else if(req.url==='/audio/v1/audio/transcriptions'){res.setHeader('content-type','application/json');res.end(JSON.stringify({text:'synthetic transcript'}));}
        else if(req.url==='/video/v1/videos'){res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'job_1',status:'completed'}));}
        else if(req.url==='/video/v1/videos/job_1/content'){res.setHeader('content-type','video/mp4');res.end(Buffer.from('synthetic-video'));}
        else {res.statusCode=404;res.end();}
      });
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      const base='http://127.0.0.1:'+server.address().port;
      try {
        const cfg={models:{providers:{openai:{baseUrl:base+'/chat/v1',apiKey:'chat-only'},'justdo-image-openai':{baseUrl:base+'/image/v1',apiKey:'image-only',request:{allowPrivateNetwork:true}},'video-openai':{baseUrl:base+'/video/v1',apiKey:'video-only',request:{allowPrivateNetwork:true}}}}};
        const original=structuredClone(cfg);
        const image=registrations.get('registerImageGenerationProvider')[0];
        assert.equal(image.isConfigured({cfg}),true);
        assert.equal(image.isConfigured({cfg:{models:{providers:{openai:cfg.models.providers.openai}}}}),false);
        const imageRequest={cfg,provider:'openai',model:'internal-image',prompt:'synthetic',timeoutMs:3000};
        assert.equal((await image.generateImage(imageRequest)).images.length,1);
        assert.equal((await image.generateImage({...imageRequest,inputImages:[{buffer:Buffer.from('input'),mimeType:'image/png'}]})).images.length,1);
        assert.deepEqual(cfg,original);
        const speechConfig=speech.resolveConfig({rawConfig:{baseUrl:base+'/speech/v1',apiKey:'speech-only',model:'internal-tts',voice:'internal-voice',responseFormat:'wav'}});
        assert.ok((await speech.synthesize({providerConfig:speechConfig,text:'synthetic',target:'audio-file',cfg,timeoutMs:3000})).audioBuffer.length);
        const audio=registrations.get('registerMediaUnderstandingProvider')[0];
        const beforeProfile=requests.length;
        const rejected=await audio.transcribeAudioWithContext({cfg,profile:'openai:account',baseUrl:base+'/audio/v1',buffer:Buffer.from('audio'),fileName:'audio.wav',timeoutMs:3000});
        assert.equal(rejected.ok,false);assert.equal(requests.length,beforeProfile);
        assert.equal((await audio.transcribeAudio({baseUrl:base+'/audio/v1',apiKey:'audio-only',buffer:Buffer.from('audio'),fileName:'audio.wav',mime:'audio/wav',model:'internal-stt',timeoutMs:3000,request:{allowPrivateNetwork:true}})).text,'synthetic transcript');
        assert.ok((await registrations.get('registerVideoGenerationProvider')[0].generateVideo({cfg,provider:'video-openai',model:'internal-video',prompt:'synthetic',timeoutMs:3000})).videos.length);
        assert.deepEqual(requests.map(r=>[r.path,r.auth]),[
          ['/image/v1/images/generations','Bearer image-only'],['/image/v1/images/edits','Bearer image-only'],
          ['/speech/v1/audio/speech','Bearer speech-only'],['/audio/v1/audio/transcriptions','Bearer audio-only'],
          ['/video/v1/videos','Bearer video-only'],['/video/v1/videos/job_1/content','Bearer video-only'],
        ]);
        assert.equal(requests.some(r=>r.auth==='Bearer chat-only'||r.auth==='Bearer synthetic-public-key'),false);
      } finally {await new Promise(resolve=>server.close(resolve));}
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
