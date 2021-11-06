const { Server } = require("net-ipc");
const { messageType } = require("../Utils/Constants.js");
const Util = require('../Utils/Util.js');

class BridgeServer extends Server {
    constructor(options = {}) {
        super(options);

        this.authToken = options.authToken;
        if(!this.authToken) throw new Error('MACHINE_MISSING_OPTION', 'authToken must be provided', 'String');
        /*********************/
        /*  Options Parsing  */
        /*********************/
        /**
        * The Total Amount of Clusters
        * @type {Number}
        */
        this.shardsPerCluster = options.shardsPerCluster ?? 1;

        /**
        * The Total Amount of Shards
        * @type {Number}
        */
        this.totalShards = options.totalShards || 'auto';
        if (this.totalShards !== undefined) {
            if (this.totalShards !== 'auto') {
                if (typeof this.totalShards !== 'number' || isNaN(this.totalShards)) {
                    throw new TypeError('CLIENT_INVALID_OPTION', 'Amount of internal shards', 'a number.');
                }
                if (this.totalShards < 1) throw new RangeError('CLIENT_INVALID_OPTION', 'Amount of internal shards', 'at least 1.');
                if (!Number.isInteger(this.totalShards)) {
                    throw new RangeError('CLIENT_INVALID_OPTION', 'Amount of internal shards', 'an integer.');
                }
            }
        }

        /**
        * The Total Amount of Machines
        * @type {Number}
        */
        this.totalMachines = options.totalMachines;
        if (!this.totalMachines) throw new Error('MISSING_OPTION', 'Total Machines', 'Provide the Amount of your Machines');
        if (typeof this.totalMachines !== 'number' || isNaN(this.totalMachines)) {
            throw new TypeError('MACHINE_INVALID_OPTION', 'Machine ID', 'must be a number.');
        }
        if (!Number.isInteger(this.totalMachines)) {
            throw new TypeError('MACHINE_INVALID_OPTION', 'Machine ID', 'must be a number.');
        }

        /**
        * Your Discord Bot token
        * @type {String}
        */
        this.token = options.token ? options.token.replace(/^Bot\s*/i, '') : null;

        /**
        * The shardList, which will be hosted by all Machines
        * @type {Array[]}
        */
        this.shardList = options.shardList ?? [];

        /**
        * The shardCLusterList, which will be hosted by all Machines
        * @type {Array[Array[]]}
        */
        this.shardClusterList;

        /**
        * The shardCLusterLisQueue, the shardList which has to be spawned on the appropriated Machine
        * @type {Array[Array[]]}
        */
        this.shardClusterListQueue;

        /**
        * The Manager instance, which should be listened, when broadcasting
        * @type {Object}
        */
        this.manager;

        //End options parsing


        this.on('ready', this._handleReady.bind(this))
        this.on('error', this._handleError.bind(this))
        this.on('connect', this._handleConnect.bind(this))
        this.on('disconnect', this._handleDisconnect.bind(this))
        this.on('message', this._handleMessage.bind(this))
        this.on('request', this._handleRequest.bind(this))

        this.clients = new Map();
    }

    start() {
        return super.start()
    }

    _handleReady(url) {
        this._debug(`[READY] Bridge operational on ${url}`)
        setTimeout(() => {
            this.initalizeShardData();
        }, 5000)
    }

    _handleError(error) {

    }

    _handleConnect(client, initialdata) {
        if (initialdata?.authToken !== this.authToken) return client.close("ACCESS DENIED").catch(e => console.log(e));
        client.authToken = initialdata.authToken;
        client.agent = initialdata.agent;
        this.clients.set(client.id, client);
        this._debug(`[CM => Connected][${client.id}]`, {cm: true})
    }

    _handleDisconnect(client, reason) {
        client = this.clients.get(client.id);
        if (!client) return;
        if (client.agent !== 'bot') return this.clients.delete(client.id);
        if (!client.shardList) return this.clients.delete(client.id);
        this.shardClusterListQueue.push(client.shardList);
        this._debug(`[CM => Disconnected][${client.id}] New ShardListQueue: ${JSON.stringify(this.shardClusterListQueue)}`)
        this.clients.delete(client.id);
    }

    _handleMessage(message, client) {
        if (message?.type === undefined) return;

        if (message.type === messageType.CLIENT_SHARDLIST_DATA_CURRENT) {
            client = this.clients.get(client.id);
            if (!this.shardClusterListQueue[0]) return;
            client.shardList = message.shardList;
            this.clients.set(client.id, client);

            const checkShardListPositionInQueue = this.shardClusterListQueue.findIndex(x => JSON.stringify(x) === JSON.stringify(message.shardList))

            if (checkShardListPositionInQueue === undefined || checkShardListPositionInQueue === -1) return;
            this.shardClusterListQueue.splice(checkShardListPositionInQueue, 1);
            this._debug(`[SHARDLIST_DATA_CURRENT][${client.id}] Current ShardListQueue: ${JSON.stringify(this.shardClusterListQueue)}`)
            return;
        }
    }

    _handleRequest(message, res, client) {
        if (message?.type === undefined) return;
        if (!this.clients.has(client.id)) return;

        ///BroadcastEval
        if (message.type === messageType.CLIENT_BROADCAST_REQUEST) {
            const clients = [...this.clients.values()].filter(c => c.agent === 'bot');

            message.type = messageType.SERVER_BROADCAST_REQUEST;
            const promises = [];
            for (const client of clients) promises.push(client.request(message));
            Promise.all(promises).then(e => res(e).catch(e => null));
            //return res.send(responses);
        }

        ///Shard Data Request
        if (message.type === messageType.SHARDLIST_DATA_REQUEST) {
            client = this.clients.get(client.id);
            if (!this.shardClusterListQueue[0]) return res([]);
            client.shardList = this.shardClusterListQueue[0];
            this._debug(`[SHARDLIST_DATA_RESPONSE][${client.id}] ShardList: ${JSON.stringify(client.shardList)}`, {cm: true})
            this.shardClusterListQueue.shift();
            res({ shardList: client.shardList, totalShards: this.totalShards });
            this.clients.set(client.id, client);
            return;
        }
    }

    //Shard Data:
    async initalizeShardData() {
        if (this.totalShards === 'auto' && !this.shardList) {
            if (!this.token) throw new Error('CLIENT_MISSING_OPTION', 'A token must be provided when getting shard count on auto', 'Add the Option token: DiscordBOTTOKEN');
            this.totalShards = await Util.fetchRecommendedShards(this.token, 1000);
            this.shardList = [...Array(this.totalShards).keys()];
        } else {
            if (isNaN(this.totalShards) && this.shardList) {
                this.totalShards = this.shardList.length;
            } else {
                if (typeof this.totalShards !== 'number' || isNaN(this.totalShards)) {
                    throw new TypeError('CLIENT_INVALID_OPTION', 'Amount of internal shards', 'a number.');
                }
                if (this.totalShards < 1) throw new RangeError('CLIENT_INVALID_OPTION', 'Amount of internal shards', 'at least 1.');
                if (!Number.isInteger(this.totalShards)) {
                    throw new RangeError('CLIENT_INVALID_OPTION', 'Amount of internal shards', 'an integer.');
                }
                this.shardList = [...Array(this.totalShards).keys()];
            }
        }
        if (this.shardList.some(shardID => shardID >= this.totalShards)) {
            throw new RangeError(
                'CLIENT_INVALID_OPTION',
                'Amount of Internal Shards',
                'bigger than the highest shardID in the shardList option.',
            );
        }



        const clusterAmount = Math.ceil(this.shardList.length / this.shardsPerCluster);
        const ClusterList = this.shardList.chunkList(Math.ceil(this.shardList.length / clusterAmount));
        this.shardClusterList = ClusterList.chunkList(Math.ceil(ClusterList.length / this.totalMachines));
        this.shardClusterListQueue = this.shardClusterList;
        this._debug(`Created shardClusterList: ${JSON.stringify(this.shardClusterList)}`)

        //Update Shard Data:
        const clients = [...this.clients.values()].filter(c => c.agent === 'bot');
        const message = {};
        message.totalShards = this.totalShards;
        message.shardClusterList = this.shardClusterList;
        message.type = messageType.SHARDLIST_DATA_UPDATE;
        for (const client of clients) client.send(message)
        this._debug(`[SHARDLIST_DATA_UPDATE][${clients.length}] To all connected Clients`, {cm: true})

        return this.shardClusterList;
    }



    ///broadcastEval:
    async broadcastEval(script, options = {}) {
        if (!script) throw new Error('Script for BroadcastEvaling has not been provided!');
        script = typeof script === 'function' ? `(${script})(this)` : script;
        const message = { script, options }
        const clients = [...this.clients.values()].filter((options.filter || (c => c.agent === 'bot')));
        message.type = messageType.SERVER_BROADCAST_REQUEST;
        const promises = [];
        for (const client of clients) promises.push(client.request(message));
        return Promise.all(promises);
    }


    /**
    * Logsout the Debug Messages
    * <warn>Using this method just emits the Debug Event.</warn>
    * <info>This is usually not necessary to manually specify.</info>
    * @returns {log} returns the log message
    */
    _debug(message, options = {}) {
        let log;
        if (options.cm) {
            log = `[Bridge => CM] ` + message;
        } else {
            log = `[Bridge] ` + message;
        }
        /**
         * Emitted upon recieving a message
         * @event ClusterManager#debug
         * @param {log} Message, which was recieved
        */
        this.emit('debug', log)
        return log;
    }
}
module.exports = BridgeServer;




Object.defineProperty(Array.prototype, 'chunkList', {
    value: function (chunkSize) {
        var R = [];
        for (var i = 0; i < this.length; i += chunkSize)
            R.push(this.slice(i, i + chunkSize));
        return R;
    }
});