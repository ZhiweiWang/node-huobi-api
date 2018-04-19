/* ============================================================
 * node-huobi-api
 https://github.com/ZhiweiWang/node-huobi-api
 * ============================================================
 * Copyright 2018-, Zhiwei Wang
 * Released under the GPL 3.0 License
 * ============================================================ */

module.exports = (function() {
    "use strict";
    const WebSocket = require("ws");
    const request = require("request");
    const crypto = require("crypto");
    const file = require("fs");
    const stringHash = require("string-hash");
    const _ = require("underscore");
    const util = require("util");
    const pako = require("pako");
    const VError = require("verror");
    const base = "https://";
    const stream = "wss://";
    const userAgent =
        "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/39.0.2171.71 Safari/537.36";
    const contentType = "application/x-www-form-urlencoded";
    let subscriptions = {};
    const default_options = {
        hadax: false,
        timeout: 30000,
        reconnect: true,
        verbose: false,
        test: false,
        log: function() {
            console.log(Array.prototype.slice.call(arguments));
        }
    };
    let options = default_options;
    let socketHeartbeatInterval;
    let channel_idx = 0;

    const getServer = function() {
        return options.hadax ? "api.hadax.com" : "api.huobipro.com";
    };

    const publicRequest = function(endpoint, params, callback, method = "GET") {
        if (!params) params = {};
        let url = `${base}${getServer()}${endpoint}`;
        let opt = {
            url: url,
            method: method,
            timeout: options.timeout,
            agent: false,
            headers: {
                "User-Agent": userAgent,
                "Content-type": contentType
            },
            qs: params,
            json: {}
        };
        request(opt, function(error, response, body) {
            if (!callback) return;

            if (error) return callback(error, {});

            if (response && response.statusCode !== 200) return callback(response, {});

            return callback(null, body);
        });
    };

    const signedRequest = function(endpoint, params, callback, method = "GET") {
        if (!options.APIKEY) throw Error("signedRequest: Invalid API Key");
        if (!options.APISECRET) throw Error("signedRequest: Invalid API Secret");
        if (!params) params = {};
        let url = `${base}${getServer()}${endpoint}`;
        params.AccessKeyId = options.APIKEY;
        params.SignatureMethod = "HmacSHA256";
        params.SignatureVersion = 2;
        params.Timestamp = new Date().toJSON().slice(0, 19);
        let query = Object.keys(params)
            .sort()
            .reduce(function(a, k) {
                a.push(k + "=" + encodeURIComponent(params[k]));
                return a;
            }, [])
            .join("&");
        let signature = crypto
            .createHmac("sha256", options.APISECRET)
            .update([method, getServer(), endpoint, query].join("\n"))
            .digest()
            .toString("base64");
        let opt = {
            url: url + "?" + query + "&Signature=" + encodeURIComponent(signature),
            method: method,
            timeout: options.timeout,
            agent: false,
            headers: {
                "User-Agent": userAgent,
                "Content-type": contentType
            },
            json: {}
        };
        request(opt, function(error, response, body) {
            if (!callback) return;

            if (error) return callback(error, {});

            if (response && response.statusCode !== 200) return callback(response, {});

            return callback(null, body);
        });
    };

    ////////////////////////////
    // reworked Tuitio's heartbeat code into a shared single interval tick
    const noop = function() {};
    const socketHeartbeat = function() {
        // sockets removed from `subscriptions` during a manual terminate()
        // will no longer be at risk of having functions called on them
        for (let endpointId in subscriptions) {
            const ws = subscriptions[endpointId];
            if (ws.isAlive) {
                ws.isAlive = false;
                if (ws.readyState === WebSocket.OPEN) ws.ping(noop);
            } else {
                if (options.verbose) options.log("Terminating inactive/broken WebSocket: " + ws.endpoint);
                if (ws.readyState === WebSocket.OPEN) ws.terminate();
            }
        }
    };
    const _handleSocketOpen = function(opened_callback) {
        this.isAlive = true;
        if (Object.keys(subscriptions).length === 0) {
            socketHeartbeatInterval = setInterval(socketHeartbeat, 30000);
        }
        subscriptions[this.endpoint] = this;
        if (typeof opened_callback === "function") opened_callback(this.endpoint);
    };
    const _handleSocketClose = function(reconnect, code, reason) {
        delete subscriptions[this.endpoint];
        if (Object.keys(subscriptions).length === 0) {
            clearInterval(socketHeartbeatInterval);
        }
        options.log(
            "WebSocket closed: " + this.endpoint + (code ? " (" + code + ")" : "") + (reason ? " " + reason : "")
        );
        if (options.reconnect && this.reconnect && reconnect) {
            if (parseInt(this.endpoint.length, 10) === 60) options.log("Account data WebSocket reconnecting...");
            else options.log("WebSocket reconnecting: " + this.endpoint + "...");
            try {
                reconnect();
            } catch (error) {
                options.log("WebSocket reconnect error: " + error.message);
            }
        }
    };
    const _handleSocketError = function(error) {
        // Errors ultimately result in a `close` event.
        // see: https://github.com/websockets/ws/blob/828194044bf247af852b31c49e2800d557fedeff/lib/websocket.js#L126
        options.log(
            "WebSocket error: " +
                this.endpoint +
                (error.code ? " (" + error.code + ")" : "") +
                (error.message ? " " + error.message : "")
        );
    };
    const _handleSocketHeartbeat = function() {
        this.isAlive = true;
    };
    const subscribe = function(endpoint, callback, reconnect = false, opened_callback = false) {
        if (options.verbose) options.log("Subscribed to " + endpoint);
        const ws = new WebSocket(`${stream}${getServer()}/ws`);
        ws.reconnect = options.reconnect;
        ws.endpoint = endpoint;
        ws.isAlive = false;
        ws.on("open", _handleSocketOpen.bind(ws, opened_callback));
        ws.on("pong", _handleSocketHeartbeat);
        ws.on("error", _handleSocketError);
        ws.on("close", _handleSocketClose.bind(ws, reconnect));
        ws.on("message", function(data) {
            try {
                let json = JSON.parse(pako.inflate(data, { to: "string" }));
                if (json.hasOwnProperty("ping")) {
                    ws.send(JSON.stringify({ pong: json.ping }));
                    return;
                }
                callback(json);
            } catch (error) {
                options.log("Parse error: " + error.message);
            }
        });
        return ws;
    };
    const subscribeCombined = function(streams, callback, reconnect = false, opened_callback = false) {
        const queryParams = streams.join("/");
        const ws = new WebSocket(`${stream}${getServer()}/ws`);
        ws.reconnect = options.reconnect;
        ws.endpoint = stringHash(queryParams);
        ws.streams = streams;
        ws.isAlive = false;
        if (options.verbose) options.log("CombinedStream: Subscribed to [" + ws.endpoint + "] " + queryParams);
        ws.on("open", _handleSocketOpen.bind(ws, opened_callback));
        ws.on("pong", _handleSocketHeartbeat);
        ws.on("error", _handleSocketError);
        ws.on("close", _handleSocketClose.bind(ws, reconnect));
        ws.on("message", function(data) {
            try {
                let json = JSON.parse(pako.inflate(data, { to: "string" }));
                if (json.hasOwnProperty("ping")) {
                    ws.send(JSON.stringify({ pong: json.ping }));
                    return;
                }
                callback(json);
            } catch (error) {
                options.log("CombinedStream: Parse error: " + error.message);
            }
        });
        return ws;
    };
    const addChannel = function(endpoint) {
        const ws = subscriptions[endpoint];
        if (ws.hasOwnProperty("streams")) {
            for (let channel of ws.streams) {
                let channelobj = { id: `id${channel_idx++}`, sub: channel };
                ws.send(JSON.stringify(channelobj));
            }
        } else {
            let channel = { id: `id${channel_idx++}`, sub: endpoint };
            ws.send(JSON.stringify(channel));
        }
    };

    const isArrayUnique = function(array) {
        let s = new Set(array);
        return s.size == array.length;
    };
    ////////////////////////////
    return {
        candlesticks: function(symbol, type, callback, options = { size: 500 }) {
            if (!callback) return;
            let params = Object.assign({ symbol, period: type }, options);
            params.size = Math.max(Math.min(params.size, 2000), 1);

            publicRequest("/market/history/kline", params, callback);
        },
        accounts: function(callback) {
            signedRequest("/v1/account/accounts", false, function(error, data) {
                if (callback) callback(error, data);
            });
        },
        balance: function(account, callback) {
            signedRequest(`/v1/${options.hadax ? "hadax/" : ""}account/accounts/${account}/balance`, false, function(
                error,
                data
            ) {
                if (callback) callback(error, data);
            });
        },
        currencys: function(callback) {
            signedRequest(`/v1/${options.hadax ? "hadax/" : ""}common/currencys`, false, function(error, data) {
                if (callback) callback(error, data);
            });
        },
        setOption: function(key, value) {
            options[key] = value;
        },
        options: function(opt, callback = false) {
            if (typeof opt === "string") {
                // Pass json config filename
                opt = JSON.parse(file.readFileSync(opt));
            }
            options = Object.assign(default_options, opt);

            if (callback) callback();
        },
        websockets: {
            subscribe: function(url, callback, reconnect = false) {
                return subscribe(url, callback, reconnect);
            },
            subscriptions: function() {
                return subscriptions;
            },
            candlesticks: function candlesticks(symbols, interval, callback) {
                let reconnect = function() {
                    if (options.reconnect) candlesticks(symbols, interval, callback);
                };
                // If an array of symbols are sent we use a combined stream connection rather.
                // This is transparent to the developer, and results in a single socket connection.
                // This essentially eliminates "unexpected response" errors when subscribing to a lot of data.
                let subscription = undefined;
                if (Array.isArray(symbols)) {
                    if (!isArrayUnique(symbols))
                        throw Error('candlesticks: "symbols" cannot contain duplicate elements.');
                    let streams = symbols.map(function(symbol) {
                        return `market.${symbol}.kline.${interval}`;
                    });
                    subscription = subscribeCombined(streams, callback, reconnect, addChannel);
                } else {
                    let symbol = symbols.toLowerCase();
                    subscription = subscribe(`market.${symbol}.kline.${interval}`, callback, reconnect, addChannel);
                }
                return subscription.endpoint;
            }
        }
    };
})();
