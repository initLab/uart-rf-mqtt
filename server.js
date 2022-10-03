'use strict';

const SerialPort = require('serialport');
const Readline = SerialPort.parsers.Readline;
const mqtt = require('mqtt');

const fs = require('fs');
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf } = format;

const config = JSON.parse(fs.readFileSync('config.json'));

const port = new SerialPort(config.serial.path, Object.assign({}, config.serial.options, {
	autoOpen: false,
}));
const parser = port.pipe(new Readline({
	delimiter: '\r\n',
}));

const myFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} ${level}: ${message}`;
});

const logger = createLogger({
  format: combine(
    timestamp(),
    myFormat
  ),
  transports: [new transports.Console()]
});

port.on('open', function() {
	logger.info('Serial port open');
});

const mqttClient = mqtt.connect(config.mqtt.options);

mqttClient.on('connect', function() {
	logger.info('MQTT connected');
	port.open();
});

mqttClient.on('message', function(topic, message) {
	if (topic.indexOf(config.mqtt.topics.subscribePrefix) !== 0) {
		logger.warn('Unknown topic: ' + topic);
		return;
	}

	logger.info('MQTT receive: ' + topic + ' ' + message.toString());

	const cmd = topic.substr(config.mqtt.topics.subscribePrefix.length);
	let msg = null;

	if (['send', 'setreceive'].indexOf(cmd) >= 0) {
		try {
			msg = JSON.parse(message);
		}
		catch (e) {
			logger.error(e.message);
			return;
		}
	}

	switch (cmd) {
		case 'send':
			let optionalParams = '';

			// noinspection JSObjectNullOrUndefined
			if (msg.pulseLength) {
				optionalParams = ' ' + msg.pulseLength;
			}

			if (msg.numRepeats) {
				if (optionalParams.length === 0) {
					optionalParams += ' 0';
				}

				optionalParams += ' ' + msg.numRepeats;
			}

			serialSend('SEND ' + msg.protocol + ' ' + msg.numBits + ' ' + msg.value + optionalParams);
			break;
		case 'setreceive':
			// noinspection JSObjectNullOrUndefined
			serialSend('SETRECEIVE ' + (msg.state ? '1' : '0'));
			break;
		case 'ping':
			serialSend('PING');
			break;
		default:
			logger.error('Unknown MQTT command: ' + cmd);
			break;
	}
});

mqttClient.subscribe(['send', 'setreceive', 'ping'].map(function(topic) {
	return config.mqtt.topics.subscribePrefix + topic;
}));

function mqttSend(cmd, data) {
	const topic = config.mqtt.topics.publishPrefix + cmd;
	logger.info('MQTT send: ' + topic + data);
	mqttClient.publish(topic, data.toString());
}

function serialSend(data) {
	logger.info('Serial send: ' + data);
	port.write(data + '\n');
}

parser.on('data', data => {
	logger.info('Serial receive: ' + data);
	const msgParts = data.split(' ');
	const cmd = msgParts[0].toLowerCase();
	const args = msgParts.slice(1);

	let mqttArgs = {
		ts: Date.now(),
	};

	switch (cmd) {
		case 'init':
		case 'ready':
		case 'sent':
		case 'pong':
			// no other details added
			break;
		case 'setreceive':
			mqttArgs.state = args[0] === 'ON';
			break;
		case 'receive':
			mqttArgs.protocol = parseInt(args[0], 10);
			mqttArgs.numBits = parseInt(args[1], 10);
			mqttArgs.value = parseInt(args[2], 10);
			mqttArgs.pulseLength = parseInt(args[3], 10);
			break;
		case 'error':
			mqttArgs = null;
			logger.error('Arduino error: ' + args);
			break;
		default:
			mqttArgs = null;
			logger.error('Unknown command: ' + cmd + ' ' + args);
			break;
	}

	if (mqttArgs) {
		mqttArgs = JSON.stringify(mqttArgs);
		mqttSend(cmd, mqttArgs);
	}
});
