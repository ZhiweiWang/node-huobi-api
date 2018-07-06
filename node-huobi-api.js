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
        log: console.log
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

    const request_once = function(params, callback) {
        if (!params || !params.req) throw Error("Wrong params format: " + params);
        if (options.verbose) options.log("Request once to " + params.req);
        params.id = `id${channel_idx++}`;
        const ws = new WebSocket(`${stream}${getServer()}/ws`);
        ws.endpoint = stringHash(JSON.stringify(params));
        ws.params = params;
        ws.isAlive = false;
        ws.on("open", _handleSocketOpen.bind(ws, reqChannel));
        ws.on("pong", _handleSocketHeartbeat);
        ws.on("error", _handleSocketError);
        ws.on("close", _handleSocketClose);
        ws.on("message", function(data) {
            try {
                let json = JSON.parse(pako.inflate(data, { to: "string" }));
                if (json.hasOwnProperty("ping")) {
                    ws.send(JSON.stringify({ pong: json.ping }));
                    return;
                }
                callback(json);
                ws.close();
            } catch (error) {
                options.log("Parse error: " + error.message);
            }
        });
        return ws;
    };
    const reqChannel = function(endpoint) {
        const ws = subscriptions[endpoint];
        ws.send(JSON.stringify(ws.params));
    };

    const subscribe = function(endpoint, callback, reconnect = false) {
        if (options.verbose) options.log("Subscribed to " + endpoint);
        const ws = new WebSocket(`${stream}${getServer()}/ws`);
        ws.reconnect = options.reconnect;
        ws.endpoint = endpoint;
        ws.isAlive = false;
        ws.on("open", _handleSocketOpen.bind(ws, addChannel));
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
    const subscribeCombined = function(streams, callback, reconnect = false) {
        const queryParams = streams.join("/");
        const ws = new WebSocket(`${stream}${getServer()}/ws`);
        ws.reconnect = options.reconnect;
        ws.endpoint = stringHash(queryParams);
        ws.streams = streams;
        ws.isAlive = false;
        if (options.verbose) options.log("CombinedStream: Subscribed to [" + ws.endpoint + "] " + queryParams);
        ws.on("open", _handleSocketOpen.bind(ws, addChannel));
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
        kline: function(symbol, type, callback, options = {}) {
            let params = Object.assign({ symbol, period: type, size: 150 }, options);
            params.size = Math.max(Math.min(params.size, 2000), 1);

            publicRequest("/market/history/kline", params, callback);
        },
        ticker: function(symbol, callback) {
            let params = { symbol };

            publicRequest("/market/detail/merged", params, callback);
        },
        ticker_detail: function(symbol, callback) {
            let params = { symbol };

            publicRequest("/market/detail", params, callback);
        },
        depth: function(symbol, callback, type = "step0") {
            let params = { symbol, type };

            publicRequest("/market/depth", params, callback);
        },
        trade_detail: function(symbol, callback) {
            let params = { symbol };

            publicRequest("/market/trade", params, callback);
        },
        trade_history: function(symbol, callback, size = 1) {
            let params = { symbol, size };
            params.size = Math.max(Math.min(params.size, 2000), 1);

            publicRequest("/market/history/trade", params, callback);
        },
        accounts: function(callback) {
            signedRequest("/v1/account/accounts", false, callback);
        },
        balance: function(account_id, callback) {
            signedRequest(
                `/v1/${options.hadax ? "hadax/" : ""}account/accounts/${account_id}/balance`,
                false,
                callback
            );
        },
        symbols: function(callback) {
            publicRequest(`/v1/${options.hadax ? "hadax/" : ""}common/symbols`, false, callback);
        },
        currencys: function(callback) {
            signedRequest(`/v1/${options.hadax ? "hadax/" : ""}common/currencys`, false, callback);
        },
        timestamp: function(callback) {
            signedRequest("/v1/common/timestamp", false, callback);
        },
        place_order: function(account_id, symbol, type, amount, callback, price = false, source = false) {
            let params = { "account-id": account_id, amount, symbol, type };
            if (price) params.price = price;
            if (source) params.source = source;

            signedRequest("/v1/order/orders/place", params, callback, "POST");
        },
        cancel_order: function(order_id, callback) {
            if (Array.isArray(order_id)) {
                if (order_id.length > 50) console.warn("only cancel first 50 orders");
                signedRequest("/v1/order/orders/batchcancel", { "order-ids": order_id.slice(0, 50) }, callback, "POST");
            } else signedRequest(`/v1/order/orders/${order_id}/submitcancel`, false, callback, "POST");
        },
        get_order: function(order_id, callback) {
            signedRequest(`/v1/order/orders/${order_id}`, false, callback);
        },
        get_matchresults: function(order_id, callback) {
            signedRequest(`/v1/order/orders/${order_id}/matchresults`, false, callback);
        },
        orders: function(
            symbol,
            status,
            callback,
            types = false,
            start = false,
            end = false,
            from = false,
            direct = false,
            size = false
        ) {
            let params = { symbol, states: status };
            if (types) params.types = types;
            if (start) params["start-date"] = start;
            if (end) params["end-date"] = end;
            if (from) params.from = from;
            if (direct) params.direct = direct;
            if (size) params.size = size;

            signedRequest("/v1/order/orders", params, callback);
        },
        matchresults: function(
            symbol,
            callback,
            types = false,
            start = false,
            end = false,
            from = false,
            direct = false,
            size = false
        ) {
            let params = { symbol };
            if (types) params.types = types;
            if (start) params["start-date"] = start;
            if (end) params["end-date"] = end;
            if (from) params.from = from;
            if (direct) params.direct = direct;
            if (size) params.size = size;

            signedRequest("/v1/order/matchresults", false, callback);
        },
        transfer_margin: function(symbol, type, currency, amount, callback) {
            if (type !== "in" && type !== "out") throw Error('margin transfer type should be "in" or "out"');
            let params = { symbol, currency, amount };

            signedRequest(`/v1/dw/transfer-${type}/margin`, params, callback, "POST");
        },
        new_margin: function(symbol, currency, amount, callback) {
            let params = { symbol, currency, amount };

            signedRequest("/v1/margin/orders", params, callback, "POST");
        },
        repay_margin: function(order_id, amount, callback) {
            let params = { amount };

            signedRequest(`/v1/margin/orders/${order_id}/repay`, params, callback, "POST");
        },
        loan_orders: function(
            symbol,
            callback,
            status = false,
            start = false,
            end = false,
            from = false,
            direct = false,
            size = false
        ) {
            let params = { symbol };
            if (status) params.states = status;
            if (start) params["start-date"] = start;
            if (end) params["end-date"] = end;
            if (from) params.from = from;
            if (direct) params.direct = direct;
            if (size) params.size = size;

            signedRequest("/v1/margin/loan-orders", params, callback);
        },
        margin_balance: function(callback, symbol = false) {
            let params = {};
            if (symbol) params.symbol = symbol;

            signedRequest("/v1/margin/accounts/balance", params, callback);
        },
        withdraw: function(address, amount, currency, callback, fee = false, tag = false) {
            let params = { address, amount, currency };
            if (fee) params.fee = fee;
            if (tag) params["addr-tag"] = tag;

            signedRequest("/v1/dw/withdraw/api/create", params, callback, "POST");
        },
        cancel_withdraw: function(withdraw_id, callback) {
            signedRequest(`/v1/dw/withdraw-virtual/${withdraw_id}/cancel`, false, callback, "POST");
        },
        deposit_withdraw: function(currency, type, callback, from = false, size = false) {
            let params = { currency, type };
            if (from) params.from = from;
            if (size) params.size = size;

            signedRequest("/v1/query/deposit-withdraw", params, callback);
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
            sub_kline: function(symbols, interval, callback) {
                let reconnect = function() {
                    if (options.reconnect) sub_kline(symbols, interval, callback);
                };
                let ws;
                if (Array.isArray(symbols)) {
                    if (!isArrayUnique(symbols)) throw Error("symbols contain duplicate elements.");
                    let streams = symbols.map(function(symbol) {
                        return `market.${symbol}.kline.${interval}`;
                    });
                    ws = subscribeCombined(streams, callback, reconnect);
                } else {
                    let symbol = symbols.toLowerCase();
                    ws = subscribe(`market.${symbol}.kline.${interval}`, callback, reconnect);
                }
                return ws.endpoint;
            },
            sub_depth: function(symbols, callback, type = "step0") {
                let reconnect = function() {
                    if (options.reconnect) sub_depth(symbols, callback, type);
                };
                let ws;
                if (Array.isArray(symbols)) {
                    if (!isArrayUnique(symbols)) throw Error("symbols contain duplicate elements.");
                    let streams = symbols.map(function(symbol) {
                        return `market.${symbol}.depth.${type}`;
                    });
                    ws = subscribeCombined(streams, callback, reconnect);
                } else {
                    let symbol = symbols.toLowerCase();
                    ws = subscribe(`market.${symbol}.depth.${type}`, callback, reconnect);
                }
                return ws.endpoint;
            },
            sub_trade: function(symbol, callback) {
                let reconnect = function() {
                    if (options.reconnect) sub_trade(symbol, callback);
                };
                let ws = subscribe(`market.${symbol}.trade.detail`, callback, reconnect);
                return ws.endpoint;
            },
            req_kline: function(symbol, period, callback, from = false, to = false) {
                from = Math.max(Math.min(from, 2524579200), 1501171200);
                to = Math.max(Math.min(to, 2524579200), 1501171200);
                if (from && to && from >= to) throw Error(`from ${from} >= to ${to}`);
                let params = { req: `market.${symbol.toLowerCase()}.kline.${period}` };
                if (from) params.from = from;
                if (to) params.to = to;

                let ws = request_once(params, callback);
                return ws.endpoint;
            },
            req_depth: function(symbol, callback, type = "step0") {
                let params = { req: `market.${symbol.toLowerCase()}.depth.${type}` };
                let ws = request_once(params, callback);
                return ws.endpoint;
            },
            req_trade: function(symbol, callback) {
                let params = { req: `market.${symbol.toLowerCase()}.trade.detail` };
                let ws = request_once(params, callback);
                return ws.endpoint;
            },
            req_detail: function(symbol, callback) {
                let params = { req: `market.${symbol.toLowerCase()}.detail` };
                let ws = request_once(params, callback);
                return ws.endpoint;
            }
        }
    };
})();
