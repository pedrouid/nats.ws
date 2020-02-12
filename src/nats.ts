/*
 * Copyright 2018-2020 The NATS Authors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


const TextEncoder = typeof window !== 'undefined' ? window.TextEncoder : undefined;

export const VERSION = require('./version.json').version;

import {extend, isArrayBuffer, stringToUint8Array} from "./util";
import {
    ClientHandlers,
    defaultReq,
    defaultSub,
    MsgCallback,
    ProtocolHandler,
    RequestOptions,
    Subscription
} from "./protocol";
import {ErrorCode, NatsError} from "./error";
import {Nuid} from "js-nuid"

const nuid = new Nuid();

export enum Payload {
    STRING = "string",
    JSON = "json",
    BINARY = "binary"
}

export interface Msg {
    subject: string;
    sid: number;
    reply?: string;
    size: number;
    data?: any;
}

export interface NatsConnectionOptions {
    connectTimeout?: number;
    name?: string;
    noEcho?: boolean;
    pass?: string;
    payload?: Payload;
    pedantic?: boolean;
    token?: string;
    url: string;
    user?: string;
    userJWT?: string | JWTProvider;
    verbose?: boolean;
}

export interface Callback {
    (): void;
}

export interface ErrorCallback {
    (error: Error): void;
}

export interface ClientEventMap {
    close: Callback;
    error: ErrorCallback;
}

export interface SubscribeOptions {
    queue?: string;
    max?: number;
}

export interface JWTProvider {
    (): string;
}

export function connect(opts: NatsConnectionOptions): Promise<NatsConnection> {
    return NatsConnection.connect(opts);
}


export class NatsConnection implements ClientHandlers {
    static VERSION = VERSION;
    options: NatsConnectionOptions;
    protocol!: ProtocolHandler;
    closeListeners: Callback[] = [];
    errorListeners: ErrorCallback[] = [];
    draining: boolean = false;

    private constructor(opts: NatsConnectionOptions) {
        this.options = {url: "ws://localhost:4222"} as NatsConnectionOptions;
        if (opts.payload === undefined) {
            opts.payload = Payload.STRING;
        }

        let payloadTypes = ["json", "string", "binary"];
        if (!payloadTypes.includes(opts.payload)) {
            throw NatsError.errorForCode(ErrorCode.INVALID_PAYLOAD_TYPE);
        }

        if (opts.user && opts.token) {
            throw (NatsError.errorForCode(ErrorCode.BAD_AUTHENTICATION));
        }
        extend(this.options, opts);
    }

    public static connect(opts: NatsConnectionOptions): Promise<NatsConnection> {
        return new Promise<NatsConnection>((resolve, reject) => {
            let nc = new NatsConnection(opts);
            ProtocolHandler.connect(opts, nc)
                .then((ph) => {
                    nc.protocol = ph;
                    resolve(nc);
                })
                .catch((err) => {
                    reject(err);
                });
        });
    }

    close(): void {
        this.protocol.close();
    }

    publish(subject: string, data: any = undefined, reply: string = ""): NatsConnection {
        subject = subject || "";
        if (subject.length === 0) {
            this.errorHandler(NatsError.errorForCode(ErrorCode.BAD_SUBJECT));
            return this;
        }
        // we take string, object to JSON and ArrayBuffer - if argument is not
        // ArrayBuffer, then process the payload
        if (!isArrayBuffer(data)) {
            if (this.options.payload !== Payload.JSON) {
                data = data || "";
            } else {
                data = data === undefined ? null : data;
                data = JSON.stringify(data);
            }
            // here we are a string

            if (TextEncoder && typeof TextEncoder !== 'undefined') {
                data = new TextEncoder().encode(data);
            } else {
                data = stringToUint8Array(data);
            }
        }

        this.protocol.publish(subject, data, reply);

        return this;
    }


    subscribe(subject: string, cb: MsgCallback, opts: SubscribeOptions = {}): Promise<Subscription> {
        return new Promise<Subscription>((resolve, reject) => {
            if (this.isClosed()) {
                reject(NatsError.errorForCode(ErrorCode.CONNECTION_CLOSED));
            }
            if (this.isDraining()) {
                reject(NatsError.errorForCode(ErrorCode.CONNECTION_DRAINING));
            }

            let s = defaultSub();
            extend(s, opts);
            s.subject = subject;
            s.callback = cb;
            resolve(this.protocol.subscribe(s));
        });
    }

    request(subject: string, timeout: number = 1000, data: any = undefined): Promise<Msg> {
        return new Promise<Msg>((resolve, reject) => {
            if (this.isClosed()) {
                reject(NatsError.errorForCode(ErrorCode.CONNECTION_CLOSED));
            }
            if (this.isDraining()) {
                reject(NatsError.errorForCode(ErrorCode.CONNECTION_DRAINING));
            }
            let r = defaultReq();
            let opts = {max: 1} as RequestOptions;
            extend(r, opts);
            r.token = nuid.next();
            //@ts-ignore
            r.timeout = setTimeout(() => {
                request.cancel();
                reject('timeout');
            }, timeout);
            r.callback = (msg: Msg) => {
                resolve(msg);
            };
            let request = this.protocol.request(r);
            this.publish(subject, data, `${this.protocol.muxSubscriptions.baseInbox}${r.token}`);
        });
    }


    /**
     * Flushes to the server. If a callback is provided, the callback is c
     * @param {Function} cb - optional
     * @returns {Promise<void> | void}
     */
    flush(cb?: Function): Promise<void> | void {
        if (cb === undefined) {
            return new Promise((resolve) => {
                this.protocol.flush(() => {
                    resolve();
                });
            });
        } else {
            this.protocol.flush(cb);
        }
    }

    drain(): Promise<any> {
        if(this.isClosed()) {
            return Promise.reject(NatsError.errorForCode(ErrorCode.CONNECTION_CLOSED));
        }
        if(this.isDraining()) {
            return Promise.reject(NatsError.errorForCode(ErrorCode.CONNECTION_DRAINING));
        }
        this.draining = true;
        return this.protocol.drain();
    }

    errorHandler(error: Error): void {
        this.errorListeners.forEach((cb) => {
            try {
                cb(error);
            } catch (ex) {
            }
        });
    }

    closeHandler(): void {
        this.closeListeners.forEach((cb) => {
            try {
                cb();
            } catch (ex) {
            }
        });
    }

    addEventListener<K extends keyof ClientEventMap>(type: K, listener: (this: NatsConnection, ev: ClientEventMap[K][]) => void): void {
        if (type === "close") {
            //@ts-ignore
            this.closeListeners.push(listener);
        } else if (type === "error") {
            //@ts-ignore
            this.errorListeners.push(listener);
        }
    }

    isClosed(): boolean {
        return this.protocol.isClosed();
    }

    isDraining(): boolean {
        return this.draining;
    }
}






