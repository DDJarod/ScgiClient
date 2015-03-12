/*
Copyright (C) 2012 Oliver Herdin https://github.com/DDJarod

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

var urlparser = require('url'),
	net = require('net'),
    util = require('util'),
	events = require('events'),
	DynamicBuffer = require('DynamicBuffer'),

	// constants for the header fields
	CONTENT_LENGTH = "CONTENT_LENGTH",
	CONTENT_LENGTH_LOWER_CASE = "content-length",
	CONTENT_TYPE = "CONTENT_TYPE",
	CONTENT_TYPE_LOWER_CASE = "content-type",
	GATEWAY_INTERFACE = "GATEWAY_INTERFACE",
	PATH_INFO = "PATH_INFO",
	PATH_TRANSLATED = "PATH_TRANSLATED",
	QUERY_STRING = "QUERY_STRING",
	REMOTE_ADDR = "REMOTE_ADDR",
	REMOTE_NAME = "REMOTE_NAME",
	REQUEST_METHOD = "REQUEST_METHOD",
	REQUEST_URI = "REQUEST_URI",
	SCGI = "SCGI",
	SERVER_PROTOCOL = "SERVER_PROTOCOL",
	SERVER_SOFTWARE = "SERVER_SOFTWARE",

	GATEWAY_INTERFACE_VALUE = "CGI/1.1",
	SCGI_VALUE = "1",
	SERVER_PROTOCOL_VALUE = "HTTP/1.1",
	SERVER_SOFTWARE_VALUE = "Node/" + process.version
	;

/**
 * Constructor for a connection. Can bind to TCP or socket scgiserver. Supports the creation of connection
 * specifications thru a function. The function must return an object like this constructor would expect.
 *
 * @constructor
 *
 * @example
 * var ScgiClient = require('ScgiClient');
 * var Connection = new ScgiClient.Connection({socket: '/tmp/my_socket'});
 *
 * @example
 * var ScgiClient = require('ScgiClient');
 * var Connection = new ScgiClient.Connection({host: '127.0.0.1', port: 8088});
 *
 * @example
 * var ScgiClient = require('ScgiClient');
 * var Connection = new ScgiClient.Connection( function(nr)
 * {
 * 	if (_nr > 10) return null;
 *  return {socket: '/tmp/my_' + nr + '_socket'};
 * });
 *
 * @param {Object|function} _connection__function the specification for a connection, or a function to generate ConnectionSpecs
 * @param {String}          _connection__function.host host to connect to
 * @param {int}             _connection__function.port port to connect to
 * @param {String}          _connection__function.socket path to the socket to use
 */
var Connection = exports.Connection = function(_connection__function)
{
	// used to parse/convert the result of the scgi server
	this.CGIParser = require('cgi/parser');

	// we will emit an 'end' event, if the request is done
	events.EventEmitter.call(this);

	// queues
	this.waitingRequests = [];
	this.idleServerConnectors = [];

	// call counter for the connection spec construction function
	var specCallNr = 1;
	if ('function' === typeof _connection__function)
	{
		// call the function as long as it does return something
		do
		{
			var connector = getConnectorFromConnectionSpec(_connection__function(specCallNr), specCallNr);
			if (connector)
			{
				this.idleServerConnectors.push(connector);
				++specCallNr;
			}
		} while(connector);
	}
	else
	{
		this.idleServerConnectors.push(getConnectorFromConnectionSpec(_connection__function, specCallNr));
	}

	// prepare the beginning of the header. This is static and not very large, we really do not need to create
	// it every time we get a request
	this.staticHeaderBuffer = new DynamicBuffer();
	this.staticHeaderBuffer	.append(':')
							.append(SCGI).write(0).append(SCGI_VALUE).write(0)
							.append(GATEWAY_INTERFACE).write(0).append(GATEWAY_INTERFACE_VALUE).write(0)
							.append(SERVER_PROTOCOL).write(0).append(SERVER_PROTOCOL_VALUE).write(0)
							.append(SERVER_SOFTWARE).write(0).append(SERVER_SOFTWARE_VALUE).write(0);

	this.staticHeaderBuffer.resizeUnderlyingBuffer();
};

//Inherit from events.EventEmitter
util.inherits(Connection, events.EventEmitter);

/**
 * handle the request
 *
 * @param {ServerRequest} _req the request
 * @param {ServerResponse} _res the response
 */
Connection.prototype.handle = function(_req, _res)
{
	var headers = _req.headers
		, resParsed = urlparser.parse(_req.url);

	_req.headersBuffer = this.staticHeaderBuffer.clone(2048, 1.25); // the header won't be much larger then 1500 in most cases

	headers[CONTENT_TYPE_LOWER_CASE] 	&& _req.headersBuffer.append(CONTENT_TYPE).write(0).append(headers[CONTENT_TYPE_LOWER_CASE]).write(0);
	_req.headersBuffer.append(QUERY_STRING).write(0).append(resParsed.query || '').write(0);
	_req.connection.remoteAddress 		&& _req.headersBuffer.append(REMOTE_ADDR).write(0).append(_req.connection.remoteAddress).write(0);
	_req.headersBuffer	.append(CONTENT_LENGTH).write(0).append(headers[CONTENT_LENGTH_LOWER_CASE] || "0").write(0)
						.append(PATH_INFO).write(0).append(resParsed.pathname.slice(this.mountPointLength)).write(0)
						.append(REQUEST_METHOD).write(0).append(_req.method).write(0)
						.append(REQUEST_URI).write(0).append(resParsed.href).write(0);

	// add the http request headers
	for (var httpProperty in headers)
	{
		_req.headersBuffer.append(httpHeaderToScgiHeaderProperty(httpProperty)).write(0).append(headers[httpProperty].toString()).write(0);
	}

	// finalize the header
	_req.headersBuffer.append(',');

	// if the request emits a 'data' event, buffer the result
	cacheDataOnReq(_req);

	// get a idle server connector
	var serverConnector = this.idleServerConnectors.shift();

	if (serverConnector)
	{
		handleRequest.call(this, _req, _res, serverConnector);
	}
	else
	{
		this.waitingRequests[this.waitingRequests.length] = handleRequest.bind(this, _req, _res);
	}
};

function handleRequest(_req, _res, _serverConnector)
{
	var server = _serverConnector.connect()
		, cgiResult = new this.CGIParser(server);

	server.on('connect', onServerConnect.bind(server, _req));
	cgiResult.on('headers', onCgiHeader.bind(cgiResult, _res));

	server.once('end', function(_noCgiCleanup)
	{
		_noCgiCleanup || cgiResult.cleanup();
		this.emit('end', _req, _serverConnector.id);
		var waitingRequest = this.waitingRequests.shift();
		if (waitingRequest)
		{
			waitingRequest(_serverConnector);
		}
		else
		{
			this.idleServerConnectors[this.idleServerConnectors.length] = _serverConnector;
		}
	}.bind(this));

	// if the browser closes the connection before the result could be send
	var endServerFunc = function(_type) {
		server.emit('end', true);
	};

	_req.on('close', endServerFunc.bind(null, 'close'));
//	_req.on('end', endServerFunc.bind(null,'end'));
};

function onCgiHeader(_res, _headers)
{
	var setCookies = [];
	for (var i = 0, header; header = _headers[i]; ++i)
	{
		// Don't set the 'Status' header. It's special, and should be
		// used to set the HTTP response code below.
		if (header.key === 'Status')
		{
			continue;
		}

		// special case set cookie header: there can be more then one!!
		if (header.key === 'Set-Cookie')
		{
			setCookies.push(header.value);
			continue;
		}

		_res.setHeader(header.key, header.value);
	}

	if (setCookies.length !== 0)
	{
		_res.setHeader('Set-Cookie', setCookies);
	}

	_res.writeHead(parseInt(_headers.status) || 200);

	// The response body is piped to the response body of the HTTP request
	this.pipe(_res);
};

function onServerConnect(_req)
{
	_req.removeAllListeners('data');

	var headerLength = _req.headersBuffer.length - 2; // -2 because we already have the ':' in front of it, and the ',' at the end

	this.write(headerLength.toString());
	this.write(_req.headersBuffer.getBuffer());

	var cachedData = _req.cachedData;
	for (var i = 0, dataChunk; dataChunk = cachedData[i]; ++i)
	{
		this.write(dataChunk);
	}

	_req.pipe(this);
};

function cacheDataOnReq(_req)
{
	_req.cachedData = [];
	var pushToCache = _req.cachedData.push.bind(_req.cachedData);
	_req.on('data', pushToCache);
};

var headerPropertyMap = {};
/**
 * trade MEM for computation, because regexp replace and toUpperCase are not for free
 */
function httpHeaderToScgiHeaderProperty(_httpHeaderProperty)
{
	var scgiProp = headerPropertyMap[_httpHeaderProperty];

	if (!scgiProp)
	{
		scgiProp = headerPropertyMap[_httpHeaderProperty] = 'HTTP_' + _httpHeaderProperty.replace(/-/g, '_').toUpperCase();
	}

	return scgiProp;
};

/**
 * check the given connection specification for validity. Returns a function which creates the connection
 */
function getConnectorFromConnectionSpec(_spec, _specCallNr)
{
	var connector = null;
	if (_spec)
	{
		if (_spec.port && _spec.host)
		{
			 connector = {
				 connect: connectToTcp.bind(this, _spec.host, _spec.port),
				 specification: _spec,
				 id: _specCallNr
			 };
		}
		else if (_spec.socket)
		{
			 connector = {
				 connect: connectToSocket.bind(this, _spec.socket),
				 specification: _spec,
				 id: _specCallNr
			 };
		}
		else
		{
			throw new Exception('A connection specification needs a host & port or a socket path');
		}
	}

	return connector;
};

function connectToSocket(_socket)
{
	return net.connect(_socket);
};

function connectToTcp(_host, _port)
{
	return net.connect(_host, _port);
};
