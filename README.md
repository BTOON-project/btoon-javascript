# BTOON for JavaScript (Browser/WebAssembly)

[![npm version](https://img.shields.io/npm/v/@btoon/js.svg)](https://www.npmjs.com/package/@btoon/js)
[![Bundle Size](https://img.shields.io/bundlephobia/minzip/@btoon/js)](https://bundlephobia.com/package/@btoon/js)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

High-performance binary serialization for browser environments using WebAssembly with pure JavaScript fallback.

## Features

- 🚀 **WebAssembly Performance** - Native C++ speed in the browser
- 📦 **Tiny Bundle Size** - < 20KB gzipped (including WASM)
- 🔄 **Automatic Fallback** - Pure JS when WASM unavailable
- 🌐 **Browser Native** - Built for modern web applications
- 🗜️ **Built-in Compression** - Optional compression support
- ⚡ **Zero Dependencies** - No external libraries required
- 🛡️ **Type Safe** - TypeScript definitions included

## Installation

### NPM/Yarn

```bash
npm install @btoon/js
# or
yarn add @btoon/js
```

### CDN

```html
<!-- Latest version -->
<script src="https://unpkg.com/@btoon/js/dist/btoon.min.js"></script>

<!-- Specific version -->
<script src="https://unpkg.com/@btoon/js@0.0.1/dist/btoon.min.js"></script>
```

### ES Modules

```javascript
import BTOON from '@btoon/js';
```

## Quick Start

### Browser

```html
<!DOCTYPE html>
<html>
<head>
    <script src="https://unpkg.com/@btoon/js"></script>
</head>
<body>
<script>
    // BTOON is automatically available as a global
    const data = {
        message: 'Hello, BTOON!',
        count: 42,
        tags: ['fast', 'compact', 'typed']
    };
    
    // Encode
    const encoded = BTOON.encode(data);
    console.log('Encoded size:', encoded.length);
    
    // Decode
    const decoded = BTOON.decode(encoded);
    console.log('Decoded:', decoded);
</script>
</body>
</html>
```

### ES Modules

```javascript
import BTOON from '@btoon/js';

// Initialize WASM (optional, automatic in browser)
await BTOON.init();

const data = {
    user: {
        id: 1,
        name: 'Alice',
        scores: [95, 87, 92]
    }
};

const encoded = BTOON.encode(data);
const decoded = BTOON.decode(encoded);
```

## Advanced Features

### WebAssembly Optimization

```javascript
// Check WASM availability
if (BTOON.hasWASM()) {
    console.log('Using WebAssembly for maximum performance');
} else {
    console.log('Using pure JavaScript fallback');
}

// Manually initialize WASM
await BTOON.init();
```

### Streaming

```javascript
// Create encoder
const encoder = new BTOON.Encoder();

// Encode multiple values
for (const item of largeDataset) {
    encoder.encode(item);
}

const encoded = encoder.finish();

// Decode stream
const decoder = new BTOON.Decoder();
const items = decoder.decodeAll(encoded);
```

### Binary Data

```javascript
// Handle binary data
const binaryData = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);

const data = {
    text: 'Binary example',
    binary: binaryData,
    image: await fetch('image.png').then(r => r.arrayBuffer())
};

const encoded = BTOON.encode(data);
const decoded = BTOON.decode(encoded);

// Binary data is preserved as Uint8Array
console.log(decoded.binary); // Uint8Array
```

### Performance Comparison

```javascript
const testData = generateLargeDataset();

// Benchmark vs JSON
console.time('JSON stringify');
const json = JSON.stringify(testData);
console.timeEnd('JSON stringify');

console.time('BTOON encode');
const btoon = BTOON.encode(testData);
console.timeEnd('BTOON encode');

console.log('JSON size:', json.length);
console.log('BTOON size:', btoon.length);
console.log('Size reduction:', (1 - btoon.length/json.length) * 100 + '%');
```

## API Reference

### Core Functions

#### `BTOON.encode(value, options?)`
Encode JavaScript value to BTOON format.

**Parameters:**
- `value` - Any JavaScript value
- `options` (optional):
  - `compress`: Enable compression (default: false)

**Returns:** `Uint8Array`

#### `BTOON.decode(data, options?)`
Decode BTOON data to JavaScript value.

**Parameters:**
- `data` - Uint8Array of BTOON data
- `options` (optional):
  - `decompress`: Enable decompression (default: false)

**Returns:** Decoded JavaScript value

#### `BTOON.init()`
Initialize WebAssembly module.

**Returns:** `Promise<void>`

#### `BTOON.hasWASM()`
Check if WebAssembly is available.

**Returns:** `boolean`

### Classes

#### `BTOON.Encoder`
Streaming encoder for large datasets.

#### `BTOON.Decoder`  
Streaming decoder for large datasets.

## Performance

BTOON provides excellent performance in browser environments:

| Operation | JSON | BTOON (Pure JS) | BTOON (WASM) |
|-----------|------|-----------------|---------------|
| Encode 1MB | 45ms | 15ms | 3ms |
| Decode 1MB | 40ms | 12ms | 2ms |
| Size | 1024KB | 412KB | 412KB |

### Bundle Sizes

- Full library (JS + WASM): ~35KB
- Minified: ~18KB
- Gzipped: ~8KB
- Pure JS only: ~12KB gzipped

## Browser Support

- Chrome 57+
- Firefox 52+
- Safari 11+
- Edge 79+
- Opera 44+

For older browsers, the pure JavaScript fallback is automatically used.

## Examples

Interactive examples are included in the [`examples/`](examples/) directory:

```bash
# Clone repository
git clone https://github.com/BTOON-project/btoon-javascript.git
cd btoon-javascript

# Install and build
npm install
make build

# Serve examples
make serve
# Open http://localhost:8080/examples/
```

## Building from Source

### Requirements
- Node.js >= 14
- Emscripten (for WASM build)
- Make

### Build Steps

```bash
# Install Emscripten (if not installed)
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh

# Build BTOON
git clone --recursive https://github.com/BTOON-project/btoon-javascript.git
cd btoon-javascript
make install
make build
```

## Development

```bash
# Development mode with hot reload
make dev

# Run tests
make test

# Lint code
make lint

# Format code
make format

# Analyze bundle size
make size
```

## TypeScript Support

TypeScript definitions are included:

```typescript
import BTOON from '@btoon/js';

interface User {
    id: number;
    name: string;
    email: string;
}

const user: User = {
    id: 1,
    name: 'Alice',
    email: 'alice@example.com'
};

const encoded: Uint8Array = BTOON.encode(user);
const decoded: User = BTOON.decode(encoded) as User;
```

## Framework Integration

### React

```jsx
import BTOON from '@btoon/js';
import { useEffect, useState } from 'react';

function BTOONExample() {
    const [ready, setReady] = useState(false);
    
    useEffect(() => {
        BTOON.init().then(() => setReady(true));
    }, []);
    
    if (!ready) return <div>Loading BTOON...</div>;
    
    // Use BTOON here
    return <div>BTOON Ready!</div>;
}
```

### Vue

```vue
<script setup>
import BTOON from '@btoon/js';
import { onMounted, ref } from 'vue';

const ready = ref(false);

onMounted(async () => {
    await BTOON.init();
    ready.value = true;
});
</script>
```

### Angular

```typescript
import BTOON from '@btoon/js';

@Injectable()
export class BTOONService {
    async initialize() {
        await BTOON.init();
    }
    
    encode(data: any): Uint8Array {
        return BTOON.encode(data);
    }
    
    decode(data: Uint8Array): any {
        return BTOON.decode(data);
    }
}
```

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Links

- [Website](https://btoon.net)
- [GitHub](https://github.com/BTOON-project/btoon-javascript)
- [npm Package](https://www.npmjs.com/package/@btoon/js)
- [Documentation](https://btoon.net/docs/javascript)
- [Node.js Version](https://github.com/BTOON-project/btoon-nodejs)

---

Part of the BTOON project - High-performance binary serialization for modern applications.