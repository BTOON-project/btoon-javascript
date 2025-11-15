/**
 * BTOON - Binary Tree Object Notation for JavaScript (Browser/WebAssembly)
 * @module btoon
 */

let wasmModule = null;
let wasmInstance = null;

/**
 * Initialize the WASM module
 * @returns {Promise<void>}
 */
async function initWASM() {
    if (wasmInstance) return;
    
    try {
        // Try to load WebAssembly module
        const response = await fetch('/wasm/btoon.wasm');
        const buffer = await response.arrayBuffer();
        const module = await WebAssembly.compile(buffer);
        wasmInstance = await WebAssembly.instantiate(module);
        wasmModule = wasmInstance.exports;
    } catch (error) {
        console.warn('WebAssembly not available, falling back to pure JavaScript', error);
        // Fall back to pure JS implementation
    }
}

/**
 * BTOON Encoder class
 */
class Encoder {
    constructor(options = {}) {
        this.options = {
            compress: false,
            algorithm: 'zlib',
            level: 6,
            autoTabular: true,
            ...options
        };
        this.buffer = [];
    }
    
    /**
     * Encode a value to BTOON format
     * @param {any} value - Value to encode
     * @returns {Uint8Array} Encoded data
     */
    encode(value) {
        if (wasmModule && wasmModule.encode) {
            // Use WASM implementation
            return this.encodeWASM(value);
        }
        // Use pure JS implementation
        return this.encodeJS(value);
    }
    
    encodeWASM(value) {
        const json = JSON.stringify(value);
        const encoder = new TextEncoder();
        const jsonBytes = encoder.encode(json);
        
        // Allocate memory in WASM
        const ptr = wasmModule.malloc(jsonBytes.length);
        const heap = new Uint8Array(wasmModule.memory.buffer, ptr, jsonBytes.length);
        heap.set(jsonBytes);
        
        // Call WASM encode function
        const resultPtr = wasmModule.btoon_encode(ptr, jsonBytes.length);
        const resultSize = wasmModule.btoon_get_size(resultPtr);
        
        // Copy result
        const result = new Uint8Array(resultSize);
        const resultHeap = new Uint8Array(wasmModule.memory.buffer, resultPtr, resultSize);
        result.set(resultHeap);
        
        // Free memory
        wasmModule.free(ptr);
        wasmModule.btoon_free(resultPtr);
        
        return result;
    }
    
    encodeJS(value) {
        // Pure JavaScript implementation
        const buffer = [];
        this.encodeValue(value, buffer);
        return new Uint8Array(buffer);
    }
    
    encodeValue(value, buffer) {
        if (value === null || value === undefined) {
            buffer.push(0xc0); // nil
        } else if (typeof value === 'boolean') {
            buffer.push(value ? 0xc3 : 0xc2);
        } else if (typeof value === 'number') {
            this.encodeNumber(value, buffer);
        } else if (typeof value === 'string') {
            this.encodeString(value, buffer);
        } else if (value instanceof Uint8Array) {
            this.encodeBinary(value, buffer);
        } else if (Array.isArray(value)) {
            this.encodeArray(value, buffer);
        } else if (typeof value === 'object') {
            this.encodeObject(value, buffer);
        }
    }
    
    encodeNumber(num, buffer) {
        if (Number.isInteger(num)) {
            if (num >= 0 && num <= 127) {
                buffer.push(num);
            } else if (num >= -32 && num < 0) {
                buffer.push(0xe0 | (num & 0x1f));
            } else {
                // Encode as int32 or int64
                buffer.push(0xd2);
                this.encodeInt32(num, buffer);
            }
        } else {
            // Float
            buffer.push(0xca);
            this.encodeFloat32(num, buffer);
        }
    }
    
    encodeString(str, buffer) {
        const bytes = new TextEncoder().encode(str);
        if (bytes.length <= 31) {
            buffer.push(0xa0 | bytes.length);
        } else if (bytes.length <= 255) {
            buffer.push(0xd9);
            buffer.push(bytes.length);
        } else {
            buffer.push(0xda);
            this.encodeUint16(bytes.length, buffer);
        }
        buffer.push(...bytes);
    }
    
    encodeBinary(data, buffer) {
        if (data.length <= 255) {
            buffer.push(0xc4);
            buffer.push(data.length);
        } else {
            buffer.push(0xc5);
            this.encodeUint16(data.length, buffer);
        }
        buffer.push(...data);
    }
    
    encodeArray(arr, buffer) {
        if (arr.length <= 15) {
            buffer.push(0x90 | arr.length);
        } else if (arr.length <= 65535) {
            buffer.push(0xdc);
            this.encodeUint16(arr.length, buffer);
        } else {
            buffer.push(0xdd);
            this.encodeUint32(arr.length, buffer);
        }
        
        for (const item of arr) {
            this.encodeValue(item, buffer);
        }
    }
    
    encodeObject(obj, buffer) {
        const keys = Object.keys(obj);
        if (keys.length <= 15) {
            buffer.push(0x80 | keys.length);
        } else if (keys.length <= 65535) {
            buffer.push(0xde);
            this.encodeUint16(keys.length, buffer);
        } else {
            buffer.push(0xdf);
            this.encodeUint32(keys.length, buffer);
        }
        
        for (const key of keys) {
            this.encodeString(key, buffer);
            this.encodeValue(obj[key], buffer);
        }
    }
    
    encodeInt32(num, buffer) {
        buffer.push((num >> 24) & 0xff);
        buffer.push((num >> 16) & 0xff);
        buffer.push((num >> 8) & 0xff);
        buffer.push(num & 0xff);
    }
    
    encodeUint16(num, buffer) {
        buffer.push((num >> 8) & 0xff);
        buffer.push(num & 0xff);
    }
    
    encodeUint32(num, buffer) {
        buffer.push((num >> 24) & 0xff);
        buffer.push((num >> 16) & 0xff);
        buffer.push((num >> 8) & 0xff);
        buffer.push(num & 0xff);
    }
    
    encodeFloat32(num, buffer) {
        const view = new DataView(new ArrayBuffer(4));
        view.setFloat32(0, num, false);
        for (let i = 0; i < 4; i++) {
            buffer.push(view.getUint8(i));
        }
    }
}

/**
 * BTOON Decoder class
 */
class Decoder {
    constructor(options = {}) {
        this.options = {
            decompress: false,
            ...options
        };
    }
    
    /**
     * Decode BTOON data
     * @param {Uint8Array} data - BTOON encoded data
     * @returns {any} Decoded value
     */
    decode(data) {
        if (wasmModule && wasmModule.decode) {
            // Use WASM implementation
            return this.decodeWASM(data);
        }
        // Use pure JS implementation
        return this.decodeJS(data);
    }
    
    decodeWASM(data) {
        // Allocate memory in WASM
        const ptr = wasmModule.malloc(data.length);
        const heap = new Uint8Array(wasmModule.memory.buffer, ptr, data.length);
        heap.set(data);
        
        // Call WASM decode function
        const resultPtr = wasmModule.btoon_decode(ptr, data.length);
        const resultSize = wasmModule.btoon_get_string_size(resultPtr);
        
        // Get JSON string
        const jsonBytes = new Uint8Array(wasmModule.memory.buffer, resultPtr, resultSize);
        const json = new TextDecoder().decode(jsonBytes);
        
        // Free memory
        wasmModule.free(ptr);
        wasmModule.btoon_free_string(resultPtr);
        
        return JSON.parse(json);
    }
    
    decodeJS(data) {
        this.buffer = data;
        this.offset = 0;
        return this.decodeValue();
    }
    
    decodeValue() {
        const byte = this.buffer[this.offset++];
        
        // Positive fixint
        if ((byte & 0x80) === 0) {
            return byte;
        }
        
        // Negative fixint
        if ((byte & 0xe0) === 0xe0) {
            return byte - 256;
        }
        
        // Fixstr
        if ((byte & 0xe0) === 0xa0) {
            const len = byte & 0x1f;
            return this.decodeString(len);
        }
        
        // Fixarray
        if ((byte & 0xf0) === 0x90) {
            const len = byte & 0x0f;
            return this.decodeArray(len);
        }
        
        // Fixmap
        if ((byte & 0xf0) === 0x80) {
            const len = byte & 0x0f;
            return this.decodeObject(len);
        }
        
        switch (byte) {
            case 0xc0: return null;
            case 0xc2: return false;
            case 0xc3: return true;
            case 0xc4: return this.decodeBinary(this.buffer[this.offset++]);
            case 0xc5: return this.decodeBinary(this.decodeUint16());
            case 0xca: return this.decodeFloat32();
            case 0xcb: return this.decodeFloat64();
            case 0xd2: return this.decodeInt32();
            case 0xd3: return this.decodeInt64();
            case 0xd9: return this.decodeString(this.buffer[this.offset++]);
            case 0xda: return this.decodeString(this.decodeUint16());
            case 0xdb: return this.decodeString(this.decodeUint32());
            case 0xdc: return this.decodeArray(this.decodeUint16());
            case 0xdd: return this.decodeArray(this.decodeUint32());
            case 0xde: return this.decodeObject(this.decodeUint16());
            case 0xdf: return this.decodeObject(this.decodeUint32());
            default:
                throw new Error(`Unknown type byte: 0x${byte.toString(16)}`);
        }
    }
    
    decodeString(len) {
        const bytes = this.buffer.slice(this.offset, this.offset + len);
        this.offset += len;
        return new TextDecoder().decode(bytes);
    }
    
    decodeBinary(len) {
        const data = this.buffer.slice(this.offset, this.offset + len);
        this.offset += len;
        return data;
    }
    
    decodeArray(len) {
        const arr = [];
        for (let i = 0; i < len; i++) {
            arr.push(this.decodeValue());
        }
        return arr;
    }
    
    decodeObject(len) {
        const obj = {};
        for (let i = 0; i < len; i++) {
            const key = this.decodeValue();
            const value = this.decodeValue();
            obj[key] = value;
        }
        return obj;
    }
    
    decodeUint16() {
        const val = (this.buffer[this.offset] << 8) | this.buffer[this.offset + 1];
        this.offset += 2;
        return val;
    }
    
    decodeUint32() {
        const val = (this.buffer[this.offset] << 24) |
                   (this.buffer[this.offset + 1] << 16) |
                   (this.buffer[this.offset + 2] << 8) |
                   this.buffer[this.offset + 3];
        this.offset += 4;
        return val;
    }
    
    decodeInt32() {
        const val = this.decodeUint32();
        return val > 0x7fffffff ? val - 0x100000000 : val;
    }
    
    decodeInt64() {
        // JavaScript doesn't have 64-bit integers, use number
        const high = this.decodeInt32();
        const low = this.decodeUint32();
        return high * 0x100000000 + low;
    }
    
    decodeFloat32() {
        const view = new DataView(new ArrayBuffer(4));
        for (let i = 0; i < 4; i++) {
            view.setUint8(i, this.buffer[this.offset++]);
        }
        return view.getFloat32(0, false);
    }
    
    decodeFloat64() {
        const view = new DataView(new ArrayBuffer(8));
        for (let i = 0; i < 8; i++) {
            view.setUint8(i, this.buffer[this.offset++]);
        }
        return view.getFloat64(0, false);
    }
}

// Main API
const BTOON = {
    VERSION: '0.0.1',
    
    /**
     * Initialize BTOON (loads WASM if available)
     * @returns {Promise<void>}
     */
    async init() {
        await initWASM();
    },
    
    /**
     * Encode a value to BTOON format
     * @param {any} value - Value to encode
     * @param {Object} options - Encoding options
     * @returns {Uint8Array} Encoded data
     */
    encode(value, options = {}) {
        const encoder = new Encoder(options);
        return encoder.encode(value);
    },
    
    /**
     * Decode BTOON data
     * @param {Uint8Array} data - BTOON encoded data
     * @param {Object} options - Decoding options
     * @returns {any} Decoded value
     */
    decode(data, options = {}) {
        const decoder = new Decoder(options);
        return decoder.decode(data);
    },
    
    /**
     * Check if WebAssembly is available
     * @returns {boolean}
     */
    hasWASM() {
        return wasmInstance !== null;
    },
    
    Encoder,
    Decoder
};

// Auto-initialize if in browser
if (typeof window !== 'undefined') {
    window.BTOON = BTOON;
    // Try to initialize WASM automatically
    BTOON.init().catch(console.warn);
}

// Export for various module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = BTOON;
}

export default BTOON;
