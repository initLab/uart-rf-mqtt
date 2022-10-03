'use strict';

const SerialPort = require('serialport');
const Readline = SerialPort.parsers.Readline;
const mqtt = require('mqtt');

const fs = require('fs');
const config = JSON.parse(fs.readFileSync('config.json'));

const port = new SerialPort(config.serial.path, Object.assign({}, config.serial.options, {
	autoOpen: false,
}));
const parser = port.pipe(new Readline({
	delimiter: '\r\n',
}));
port.on('open', function() {
	console.log('Serial port open');
});

const mqttClient = mqtt.connect(config.mqtt.options);

mqttClient.on('connect', function() {
	console.log('MQTT connected');
	port.open();
});

mqttClient.on('message', function(topic, message, packet) {
	if (topic.indexOf(config.mqtt.topics.subscribePrefix) !== 0) {
		console.warn('Unknown topic:', topic);
		return;
	}
	
	console.log('MQTT receive:', topic, message.toString());
	
	const cmd = topic.substr(config.mqtt.topics.subscribePrefix.length);
	let msg = null;
	
	if (['send', 'setreceive'].indexOf(cmd) >= 0) {
		try {
			msg = JSON.parse(message);
		}
		catch (e) {
			console.error(e.message);
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
			console.error('Unknown MQTT command:', cmd);
			break;
	}
});

mqttClient.subscribe(['send', 'setreceive', 'ping'].map(function(topic) {
	return config.mqtt.topics.subscribePrefix + topic;
}));

function mqttSend(cmd, data) {
	const topic = config.mqtt.topics.publishPrefix + cmd;
	console.log('MQTT send:', topic, data);
	mqttClient.publish(topic, data.toString());
}

function serialSend(data) {
	console.log('Serial send:', data);
	port.write(data + '\n');
}

parser.on('data', data => {
	console.log('Serial receive:', data);
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
			console.error('Arduino error:', args);
			break;
		default:
			mqttArgs = null;
			console.error('Unknown command:', cmd, args);
			break;
	}
	
	if (mqttArgs) {
		mqttArgs = JSON.stringify(mqttArgs);
		mqttSend(cmd, mqttArgs);
	}
});
