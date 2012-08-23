[![build status](https://secure.travis-ci.org/DDJarod/ScgiClient.png)](http://travis-ci.org/DDJarod/ScgiClient)
#ScgiClient for node.js

Yet another scgi client module for node.js. 
In comparison to scgi-client, this module does have more features, but cannot be configured that much.
It should have better performance, but I haven't benchmarked it yet.

##Examples

### Simple examples:
There is a server running that does accept a scgi connection on a socket.

    var ScgiClient = require('ScgiClient');
    var Connection = new ScgiClient.Connection({socket: '/tmp/my_socket'});
    
There is a server running that does accept a scgi connection on a port on that is accessiple with tcp.

    var ScgiClient = require('ScgiClient');
    var Connection = new ScgiClient.Connection({host: '127.0.0.1', port: 8088});

### Advanced example:
In this example, we have 10 server, which listen on sockets /tmp/my_1\_socket to socket /tmp/my_10\_socket
We supply a function to the constructor instead of the location of the server. That function return the location of server N, where N is given as argument, or null, if no more server are available to connect.

    var ScgiClient = require('ScgiClient');
    var Connection = new ScgiClient.Connection( function(nr) 
    {
      if (_nr > 10) return null;
      return {socket: '/tmp/my_' + nr + '_socket'};
    });