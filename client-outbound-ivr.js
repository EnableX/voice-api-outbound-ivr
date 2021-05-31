// core modules
const fs = require('fs');
const http = require('http');
const https = require('https');
// modules installed from npm
const { EventEmitter } = require('events');
const express = require('express');
const bodyParser = require('body-parser');
const { createDecipher } = require('crypto');
require('dotenv').config();
const _ = require('lodash');
// application modules
const logger = require('./logger');
const {
  ivrVoiceCall, makeOutboundCall, hangupCall,
} = require('./voiceapi');

// Express app setup
const app = express();
const eventEmitter = new EventEmitter();

let server;
let callVoiceId;
let retrycount = 0;
let ttsPlayVoice = 'female';
const sseMsg = [];
const servicePort = process.env.SERVICE_PORT || 3000;

// shutdown the node server forcefully
function shutdown() {
  server.close(() => {
    logger.error('Shutting down the server');
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(1);
  }, 10000);
}

// Set webhook event url
function onListening() {
  logger.info(`Listening on Port ${servicePort}`);
}

// Handle error generated while creating / starting an http server
function onError(error) {
  if (error.syscall !== 'listen') {
    throw error;
  }

  switch (error.code) {
    case 'EACCES':
      logger.error(`Port ${servicePort} requires elevated privileges`);
      process.exit(1);
      break;
    case 'EADDRINUSE':
      logger.error(`Port ${servicePort} is already in use`);
      process.exit(1);
      break;
    default:
      throw error;
  }
}

// create and start an HTTPS node app server
// An SSL Certificate (Self Signed or Registered) is required
function createAppServer() {
  if (process.env.LISTEN_SSL) {
    const options = {
      key: fs.readFileSync(process.env.CERTIFICATE_SSL_KEY).toString(),
      cert: fs.readFileSync(process.env.CERTIFICATE_SSL_CERT).toString(),
    };
    if (process.env.CERTIFICATE_SSL_CACERTS) {
      options.ca = [];
      options.ca.push(fs.readFileSync(process.env.CERTIFICATE_SSL_CACERTS).toString());
    }
    // Create https express server
    server = https.createServer(options, app);
  } else {
    // Create http express server
    server = http.createServer(app);
  }
  app.set('port', servicePort);
  server.listen(servicePort);
  server.on('error', onError);
  server.on('listening', onListening);
}

/* Initializing WebServer */
if (process.env.ENABLEX_APP_ID && process.env.ENABLEX_APP_KEY) {
  createAppServer();
} else {
  logger.error('Please set env variables - ENABLEX_APP_ID, ENABLEX_APP_KEY');
}

process.on('SIGINT', () => {
  logger.info('Caught interrupt signal');
  shutdown();
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static('client'));

// outbound voice call
// req contains fromNumber, toNumber, TTS text, & voice (gender)
app.post('/outbound-call', (req, res) => {
  logger.info(`Initiating a call from ${req.body.from} to ${req.body.to}`);
  // set msg to be used for SSE events to display on webpage
  sseMsg.push(`Initiating a call from ${req.body.from} to ${req.body.to}`);
  // voice (gender) received from request will also be used in webhook
  ttsPlayVoice = req.body.play_voice;

  /* Initiating Outbound Call */
  makeOutboundCall(req.body, (response) => {
    const msg = JSON.parse(response);
    // set voice_id to be used throughout
    callVoiceId = msg.voice_id;
    logger.info(`Voice Id of the Call ${callVoiceId}`);
    res.send(msg);
    res.status(200);
  });
});

// It will send stream / events all the events received from webhook to the client
app.get('/event-stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const id = (new Date()).toLocaleTimeString();

  setInterval(() => {
    if (!_.isEmpty(sseMsg[0])) {
      const data = `${sseMsg[0]}`;
      res.write(`id: ${id}\n`);
      res.write(`data: ${data}\n\n`);
      sseMsg.pop();
    }
  }, 100);
});

// Webhook event which will be called by EnableX server once an outbound call is made
// It should be publicly accessible. Please refer document for webhook security.
app.post('/event', (req, res) => {
  let jsonObj;
  if (req.headers['x-algoritm'] !== undefined) {
    const key = createDecipher(req.headers['x-algoritm'], process.env.ENABLEX_APP_ID);
    let decryptedData = key.update(req.body.encrypted_data, req.headers['x-format'], req.headers['x-encoding']);
    decryptedData += key.final(req.headers['x-encoding']);
    jsonObj = JSON.parse(decryptedData);
    logger.info('Response from webhook');
    logger.info(JSON.stringify(jsonObj));
  } else {
    jsonObj = req.body;
    logger.info(JSON.stringify(jsonObj));
  }

  res.send();
  res.status(200);
  eventEmitter.emit('voicestateevent', jsonObj);
});

// Call is completed / disconneted, inform server to hangup the call
function timeOutHandler() {
  logger.info(`[${callVoiceId}] Disconnecting the call`);
  hangupCall(callVoiceId, () => { });
  shutdown();
}

/* WebHook Event Handler function */
function voiceEventHandler(voiceEvent) {
  console.log("Voice Event Received : " + JSON.stringify(voiceEvent));
  if (voiceEvent.state) {
    if (voiceEvent.state === 'connected') {
      const eventMsg = 'Outbound Call is connected';
      logger.info(`[${callVoiceId}] ${eventMsg}`);
      sseMsg.push(eventMsg);
    } else if (voiceEvent.state === 'disconnected') {
      const eventMsg = 'Outbound Call is disconnected';
      logger.info(`[${callVoiceId}] ${eventMsg}`);
      sseMsg.push(eventMsg);
    }
  }

  if (voiceEvent.playstate !== undefined) {
    if (voiceEvent.playstate === 'playfinished') {
       console.log ("["+callVoiceId+"] Playing voice menu");
       ivrVoiceCall(callVoiceId, ttsPlayVoice, "Please press one for sales, two for enquiry, three for accounts", 'voice_menu', () => {});
       ++retrycount;
    } else if (voiceEvent.playstate === 'menutimeout'){
       console.log ("["+callVoiceId+"]  menutimeout received");
      if (voiceEvent.prompt_ref === 'timeout') {
        if(retrycount === 3) {
          console.log("["+callVoiceId+"] max retry reached" );
          ivrVoiceCall(callVoiceId, ttsPlayVoice, "I am sorry you have reached maximum retries", 'maxretryreach', () => {});
        } else if(voiceEvent.prompt_ref === 'voice_menu') {
          console.log ("["+callVoiceId+"] Playing menu timeout prompt");
          ivrVoiceCall(callVoiceId, ttsPlayVoice, "Please press a digit to continue", 'timeout', () => {});
        } else {
            ++retrycount;
            console.log ("["+callVoiceId+"] Playing voice menu again");
            ivrVoiceCall(callVoiceId, ttsPlayVoice, "Please press one for sales, two for enquiry, three for accounts", 'voice_menu', () => {});
        }
      } else if(voiceEvent.prompt_ref ==='maxretryreach') {
        console.log("["+callVoiceId+"] max retry reached");
        setTimeout(timeOutHandler, 1000);
      } else {
        console.log ("["+callVoiceId+"] Playing menu timeout prompt");
        ivrVoiceCall(callVoiceId, ttsPlayVoice, "Please press a digit to continue", 'timeout', () => {});
      }
    } else if(voiceEvent.playstate === 'digitcollected' && voiceEvent.prompt_ref === 'voice_menu') {
      console.log ("["+callVoiceId+"] voice menu digit collected =>  " + voiceEvent.digit + " disconnecting the call");
      setTimeout(timeOutHandler, 1000);
    } else if(voiceEvent.playstate && voiceEvent.playstate === 'initiated') {
      console.log ("["+callVoiceId+"] Play initiated, [play_id] " + voiceEvent.play_id);
    } else {
      console.log ("["+callVoiceId+"] Unknown event received");
    }
  }
}

/* Registering WebHook Event Handler function */
eventEmitter.on('voicestateevent', voiceEventHandler);
