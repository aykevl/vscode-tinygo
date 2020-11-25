'use strict';

// Using metric units. For the conversion, see:
// https://en.wikipedia.org/wiki/Surface-mount_technology#Packages

// A device is the base class for all electronic components: LEDs, MCUs, and
// even whole boards.
class Device {
    // Properties of this particular instance (that can sometimes change).
    //  - id
    //  - type
    //  - url
    //  - x, y (in pixels)
    //  - color
    properties = null;

    // Read-only details that are fixed for this instance.
    //  - width, height (in mm)
    //  - background
    //  - objects
    //  - pins
    data = null;

    constructor(parent, properties, data) {
        this.parent = parent;
        this.properties = properties;
        this.data = data;
        this.element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.element.classList.add('device');
        this.element.dataset.id = this.id; // mainly for debugging
    }

    get id() {
        return this.properties.id;
    }

    get name() {
        return this.properties.name || this.data.name;
    }

    get width() {
        return this.data.width;
    }

    get height() {
        return this.data.height;
    }

    get rotation() {
        return this.properties.rotation || 0;
    }

    updateShape() {
        this.element.style.width = this.width + 'mm';
        this.element.style.height = this.height + 'mm';
    }

    // Return this and all child objects.
    getObjects() {
        // For most devices, simply return itself.
        // Composite devices need to override this method.
        return new Set([this]);
    }

    getPin(index) {
        return this.pins[index];
    }

    getPinByName(name) {
        for (let pin of this.pins) {
            if (pin.name == name) {
                return pin;
            }
        }
    }

    // getHTML returns the element that should be placed in the devices tab of
    // the bottom panel. It returns null if the device does not support this.
    getHTML() {
        return null;
    }

    onPinChange(pin) {
    }

    writeWS2812Byte(pin, c) {
    }
}

class Microcontroller extends Device {
    constructor(parent, properties, data) {
        super(parent, properties, data);
        this.pins = [];
        for (let pinData of data.pins) {
            this.pins.push(new Pin(this, pinData));
        }
        this.spiBuses = {};

        this.runner = null;
    }

    async runURL(url, logger) {
        // Compile the script.
        if (this.runner) {
            this.runner.stop();
        }
        for (let pin of this.pins) {
            pin.reset();
        }
        this.runner = new Runner(this, logger);
        await this.runner.run(await fetch(url));
    }

    async runBinary(binary, logger) {
        if (this.runner) {
            this.runner.stop();
        }
        for (let pin of this.pins) {
            pin.reset();
        }
        this.runner = new Runner(this, logger);
        await this.runner.run(binary);
    }

    // getSPI returns a SPI controller (master).
    getSPI(number) {
        if (!(number in this.spiBuses)) {
            this.spiBuses[number] = new SPIController();
        }
        return this.spiBuses[number];
    }

    // configureSPI configures a SPI controller with the given pins, which
    // should be numeric values specific for this MCU.
    configureSPI(number, sck, sdo, sdi) {
        this.getSPI(number).configure(this.getPin(sck), this.getPin(sdo), this.getPin(sdi));
    }
}

class LED extends Device {
    static shapes = {
        'tht-5mm': {
            width: 5,
            height: 5,
            type: 'tht',
            name: '5mm',
        },
        'smd-2012': {
            width: 2.0,
            height: 1.2,
            type: 'smd',
            name: 'SMD 2012/0806 (2.0x1.2mm)',
        },
    };

    constructor(parent, properties) {
        if (!properties.color) {
            // Default color to red.
            properties.color = '#ff0000';
        }
        if (!(properties.shape in LED.shapes)) {
            // Default shape to a typical 5mm through hole LED.
            properties.shape = 'tht-5mm';
        }
        super(parent, properties);

        // Create the div for the devices panel.
        this.infoDiv = document.createElement('div');

        this.pins = [
            new Pin(this, {name: 'anode'}),
            new Pin(this, {name: 'cathode'}),
        ];

        // Create shape.
        this.updateShape();
    }

    get name() {
        return this.properties.name || 'LED';
    }

    get shapes() {
        return LED.shapes;
    }

    get shape() {
        return this.shapes[this.properties.shape];
    }

    get width() {
        return this.shape.width;
    }

    get height() {
        return this.shape.height;
    }

    updateShape() {
        super.updateShape();

        // Remove old shape if necessary.
        if (this.plastic) {
            this.plastic.remove();
            this.plastic = undefined;
        }
        if (this.base) {
            this.base.remove();
            this.base = undefined;
        }

        // Update pin pads.
        if (this.parent instanceof Play) {
            // Not on a board, so show the pins.
            this.pins[0].data.x = -0.5;
            this.pins[0].data.y = this.height / 2;
            this.pins[0].updateShape();
            this.pins[1].data.x = this.width + 0.5;
            this.pins[1].data.y = this.height / 2;
            this.pins[1].updateShape();
        }

        if (this.shape.type == 'smd') {
            // Create the base of the LED.
            this.base = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            this.base.style.left = 0;
            this.base.style.top = 0;
            this.base.style.width = '2.0mm';
            this.base.style.height = '1.2mm';
            this.base.style.fill = '#a88b32';
            this.element.appendChild(this.base);

            // Create the square piece of plastic that contains the chip itself.
            this.plastic = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            this.plastic.style.x = '0.4mm';
            this.plastic.style.y = 0;
            this.plastic.style.width = '1.2mm';
            this.plastic.style.height = '1.2mm';
            this.plastic.style.fill = this.properties.color;
            this.element.appendChild(this.plastic);
        } else { // tht
            // Create the round piece of plastic that is the outside part of the
            // LED.
            this.plastic = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            this.element.appendChild(this.plastic);
            this.plastic.style.r = (this.width / 2 ) + 'mm';
            this.plastic.style.cx = (this.width / 2 ) + 'mm';
            this.plastic.style.cy = (this.width / 2 ) + 'mm';
            this.plastic.style.fill = this.properties.color;
            this.element.appendChild(this.plastic);
        }

        // Update on/off state.
        this.onPinChange();
    }

    set(on) {
        let opacity = '0.5';
        let filter = '';
        if (on) {
            opacity = ''
            let size = (0.4 + this.height / 4) + 'mm';
            filter = 'drop-shadow(0 0 ' + size + ' ' + this.properties.color + ')';
        }
        this.plastic.style.opacity = opacity;
        this.plastic.style.filter = filter;

        this.infoDiv.textContent = on ? 'on' : 'off';
    }

    getHTML() {
        return this.infoDiv;
    }

    onPinChange() {
        // The LED turns on when at least one of the pins is correctly connected
        // (not floating). This makes it easier to wire them (no need for a
        // VCC/ground wire) while retaining somewhat real-world behavior by not
        // turning on when both pins are floating.
        let anodeConnected = this.pins[0].connected.size > 1;
        let cathodeConnected = this.pins[1].connected.size > 1;
        let on = anodeConnected || cathodeConnected;
        if (anodeConnected && !this.pins[0].isHigh()) {
            on = false;
        }
        if (cathodeConnected && !this.pins[1].isLow()) {
            on = false;
        }
        this.set(on);
    }
}

class WS2812 extends Device {
    constructor(parent, properties) {
        super(parent, properties, {
            width: 5,
            height: 5,
        });

        // Color bytes in the WS2812 shift register.
        this.bytesInShiftRegister = 0; // reset to 0 every latch
        this.color = [0, 0, 0];

        this.pins = [
            new Pin(this, {name: 'din', x: -0.5, y: 2.5, mode: 'input'}),
            new Pin(this, {name: 'dout', x: 5.5, y: 2.5, mode: 'output'}),
        ];

        let base = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        this.element.appendChild(base);
        base.style.fill = 'white';
        base.style.x = 0;
        base.style.y = 0;
        base.style.width = '5mm';
        base.style.height = '5mm';

        this.led = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        this.element.appendChild(this.led);
        this.led.style.r = '2mm';
        this.led.style.cx = '2.5mm';
        this.led.style.cy = '2.5mm';
        this.led.style.fill = 'black';

        this.infoDiv = document.createElement('div');
        this.infoDiv.innerHTML = 'rgb(<span class="r">0</span>, <span class="g">0</span>, <span class="b">0</span>)';
    }

    get name() {
        return 'WS2812';
    }

    getHTML() {
        return this.infoDiv;
    }

    writeWS2812Byte(pin, c) {
        // Only listen to this if the signal comes from the input pin.
        if (pin != this.pins[0])
            return;

        // Shift data to the next device. Only do this when there are already 3
        // bytes in the shift register (reset on latch) to match actual WS2812
        // behavior.
        if (this.bytesInShiftRegister == 3) {
            for (let pin of this.pins[1].connected) {
                pin.device.writeWS2812Byte(pin, this.color[2]);
            }
        }

        // Shift data into internal shift register.
        this.color[2] = this.color[1];
        this.color[1] = this.color[0];
        this.color[0] = c;
        this.bytesInShiftRegister = Math.min(3, this.bytesInShiftRegister+1);

        // Update the LED after some time has passed.
        if (!this.latchTimeout) {
            this.latchTimeout = requestAnimationFrame(this.latch.bind(this), 0);
        }
    }

    latch() {
        this.latchTimeout = undefined;
        this.bytesInShiftRegister = 0;

        // Colors are normally in GRB order.
        // Because colors get shifted, the order is reversed.
        let g = this.color[2];
        let r = this.color[1];
        let b = this.color[0];

        this.infoDiv.querySelector('.r').textContent = r;
        this.infoDiv.querySelector('.g').textContent = g;
        this.infoDiv.querySelector('.b').textContent = b;

        let brightness = (r + g + b) / (255*3);

        // Do a gamma correction. The LEDs are in linear color space, while the
        // web uses the sRGB color space (with gamma=~2.2).
        // I'm not sure why the gamma needs to be this high (gamma=4), but that's
        // how I managed to get them sort-of similar to the real LEDs.
        // Without any gamma correction, the LEDs would look way too dark.
        r = Math.pow(r / 255, 1/4) * 255;
        g = Math.pow(g / 255, 1/4) * 255;
        b = Math.pow(b / 255, 1/4) * 255;
        brightness = Math.pow(brightness, 1/4);

        let filter = 'drop-shadow(0 0 2mm rgba(' + [r, g, b, brightness].join(', ') + '))';
        this.led.style.filter = filter;
        this.led.style.fill = 'rgb(' + r + ', ' + g + ', ' + b + ')';
    }
}

// ST7789 is a chip used on SPI connected displays.
class ST7789 extends Device {
    constructor(parent, properties) {
        super(parent, properties, {
            name:         'ST7789',
            width:        26,
            height:       26,
            pixelWidth:   240,
            pixelHeight:  240,
            columnOffset: 0,
            rowOffset:    80,
        });

        this.sck = new Pin(this, {name: 'SCK', x: 2.54,  y: -1}), // serial clock
        this.sdi = new Pin(this, {name: 'SDI', x: 5.08,  y: -1}), // serial data in
        this.dc = new Pin(this, {name: 'DC',  x: 7.62,  y: -1}), // data/command
        this.cs = new Pin(this, {name: 'CS',  x: 10.16, y: -1}), // chip select
        this.pins = [this.sck, this.sdi, this.dc, this.cs];
        // TODO: chip select, maybe LED pins

        let base = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        base.setAttribute('fill', '#222');
        base.setAttribute('width', this.data.width+'mm');
        base.setAttribute('height', this.data.height+'mm');
        this.element.appendChild(base);

        let foreignObject = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
        foreignObject.setAttribute('x', '1mm');
        foreignObject.setAttribute('y', '1mm');
        foreignObject.setAttribute('width', '24mm');
        foreignObject.setAttribute('height', '24mm');
        this.element.appendChild(foreignObject);

        let display = document.createElement('canvas');
        display.setAttribute('width', this.data.pixelWidth);
        display.setAttribute('height', this.data.pixelHeight);
        display.style.width = '24mm';
        display.style.height = '24mm';
        foreignObject.appendChild(display);

        this.ctx = display.getContext('2d');
        this.ctx.fillStyle = 'black';
        this.ctx.fillRect(0, 0, this.data.pixelWidth, this.data.pixelHeight);

        this.inReset = false;
        this.command = 0x00; // no-op
        this.dataBuf = null;
        this.reset();
    }

    // Reset all registers to their default state.
    reset() {
        this.xs = 0;
        this.xe = 0xef; // note: depends on MV value
        this.ys = 0;
        this.ye = 0x13f; // note: depends on MV value
        this.inverse = false; // display inversion off

        // Give these a sensible default value. Will be updated with the RAMWR
        // command.
        this.x = 0;
        this.y = 0;
        this.dataByte = null;
        this.currentColor = -1;
    }

    transferSPI(b, sck, sdi) {
        // Check whether the signal is received correctly.
        if (!sck.connected.has(this.sck) || !sdi.connected.has(this.sdi))
            return;

        // Check the chip select signal.
        if (this.cs.isHigh()) {
            return;
        }

        if (this.dc.isHigh()) { // received data
            if (this.dataBuf !== null) {
                this.dataBuf.push(b);
            }
            if (this.command == 0x2a && this.dataBuf.length == 4) {
                // CASET: column address set
                this.xs = (this.dataBuf[0] << 8) + this.dataBuf[1];
                this.xe = (this.dataBuf[2] << 8) + this.dataBuf[3];
                if (this.xs > this.xe) {
                    console.error('st7789: xs must be smaller than or equal to xe');
                }
            } else if (this.command == 0x2b && this.dataBuf.length == 4) {
                // RASET: row address set
                this.ys = (this.dataBuf[0] << 8) + this.dataBuf[1];
                this.ye = (this.dataBuf[2] << 8) + this.dataBuf[3];
                if (this.ys > this.ye) {
                    console.error('st7789: ys must be smaller than or equal to ye');
                }
            } else if (this.command == 0x2c) {
                // RAMWR: memory write
                if (this.dataByte === null) {
                    // First byte received. Record this byte for later use.
                    this.dataByte = b;
                } else {
                    // Second byte received.
                    let word = (this.dataByte << 8) + b;
                    this.dataByte = null;

                    // Set the correct color, if it was different from the previous
                    // color.
                    if (this.currentColor != word) {
                        this.currentColor = word;
                        let red = Math.round((word >> 11) * 255 / 31);
                        let green = Math.round(((word >> 5) & 63) * 255 / 63);
                        let blue = Math.round((word & 31) * 255 / 31);
                        this.ctx.fillStyle = 'rgb(' + red + ',' + green + ',' + blue + ')';
                    }

                    // Draw the pixel.
                    let x = this.x - (this.data.columnOffset || 0);
                    let y = this.y - (this.data.rowOffset || 0);
                    if (x >= 0 && y >= 0 && x < this.data.pixelWidth && y < this.data.pixelHeight) {
                        this.ctx.fillRect(x, y, 1, 1);
                    }

                    // Increment row/column address.
                    this.x += 1;
                    if (this.x > this.xe) {
                        this.x = this.xs;
                        this.y += 1;
                    }
                    if (this.y > this.ye) {
                        this.y = this.ys;
                    }
                }
            } else if (this.command == 0x36 && this.dataBuf.length == 1) {
                // MADCTL: memory data access control
                // Controls how the display is updated, and allows rotating it.
                if (this.dataBuf[0] != 0xc0) {
                    console.warn('st7789: unknown MADCTL value:', this.dataBuf[0]);
                }
            } else if (this.command == 0x3a && this.dataBuf.length == 1) {
                // COLMOD: color format
                if (this.dataBuf[0] != 0x55) {
                    // Only the 16-bit interface is currently supported.
                    console.warn('st7789: unknown COLMOD value:', this.dataBuf[0]);
                }
            }
        } else {
            this.command = b;
            this.dataBuf = null;
            if (b == 0x01) {
                // SWRESET: re-initialize all registers
                this.reset();
            } else if (b == 0x11) {
                // SLPOUT: nothing to do
            } else if (b == 0x13) {
                // NORON: normal display mode on
                // Sets the display to normal mode (as opposed to partial mode).
                // Defaults to on, so nothing to do here.
            } else if (b == 0x20) {
                // INVOFF: display inversion off
                this.inverse = false;
            } else if (b == 0x21) {
                // INVON: display inversion on
                this.inverse = true;
            } else if (b == 0x29) {
                // DISPON: display on
                // The default is to disable the display, this command enables it.
                // Ignore it, it's not super important in simulation (but should
                // eventually be implemented by blanking the display when off).
            } else if (b == 0x2a || b == 0x2b) {
                // CASET: column address set
                // RASET: row address set
                this.dataBuf = [];
            } else if (b == 0x2c) {
                // RAMWR: memory write
                this.x = this.xs;
                this.y = this.ys;
                this.dataByte = null;
            } else if (b == 0x3a) {
                // COLMOD: interface pixel format
                this.dataBuf = [];
            } else if (b == 0x36) {
                // MADCTL: memory data access control
                // It can be used to rotate/swap the display (see 8.12 Address Control
                // in the PDF), but has not yet been implemented.
                this.dataBuf = [];
            } else {
                // unknown command
                console.log('st7789: unknown command:', b);
            }
        }
    }
}

class Composite extends Device {
    constructor(parent, properties, data) {
        super(parent, properties, data);

        if (data.background) {
            // Load the background SVG using a promise so that loadChildren can
            // wait until the background is fully loaded. The pins are only
            // fully valid (with backgroundElement set) after this is done.
            this.backgroundLoaded = new Promise((resolve, reject) => {
                // Using an XHR here because the fetch API doesn't directly
                // allow loading XML documents.
                let req = new XMLHttpRequest();
                req.responseType = 'document';
                req.open('GET', 'devices/'+data.background);
                req.send();
                req.onload = () => {
                    let svg = req.response.documentElement;
                    this.element.prepend(svg);
                    for (let i=0; i<this.pins.length; i++) {
                        let pin = this.pins[i];
                        if (pin.data.svgId) {
                            pin.backgroundElement = svg.getElementById(pin.data.svgId);
                            pin.backgroundElement.classList.add('pin');
                        }
                    }
                    resolve();
                };
                req.onerror = (e) => {
                    // TODO: properly handle this error.
                    console.error('failed to load device background for '+this.name+':', e)
                }
            });
        }

        this.pins = [];
        for (let pinData of this.data.pins) {
            let pin = new Pin(this, pinData);
            this.pins.push(pin);
        }
    }

    async loadChildren() {
        this.objects = {};
        for (let child of this.data.objects) {
            let obj = await createObject(this, child);
            this.objects[child.id] = obj;
            this.element.appendChild(obj.element);
            let [x, y] = applyRotation(obj.rotation, obj.width, obj.height);
            obj.element.style.transform = 'translate(' + (child.x + x) + 'mm, ' + (child.y + y) + 'mm) rotate(' + obj.rotation + 'deg)';
        }

        for (let i=0; i<this.pins.length; i++) {
            let pin = this.pins[i];
            pin.connectedOnBoard = new Set();
            pin.connectedOnBoard.add(pin);
            if (pin.data.connected) {
                for (let connection of pin.data.connected) {
                    let childPin = this.objects[connection.id].getPinByName(connection.pin);
                    if (!childPin) {
                        console.error('pin undefined:', connection);
                        continue;
                    }
                    pin.connectedOnBoard.add(childPin);
                    childPin.connectedOnBoard = pin.connectedOnBoard;
                }
            }
        }

        // It may be necessary to load until the background is fully loaded
        // before returning (as otherwise the pins are not ready).
        if (this.backgroundLoaded) {
            await this.backgroundLoaded;
        }
    }

    get name() {
        return this.properties.name || this.data.name;
    }

    // Return this and all child objects.
    getObjects() {
        let objects = new Set([this]);
        for (let id in this.objects) {
            for (let child of this.objects[id].getObjects()) {
                objects.add(child);
            }
        }
        return objects;
    }
}

let devices = {
    mcu: Microcontroller,
    led: LED,
    ws2812: WS2812,
    st7789: ST7789,
};

function hasParent(element) {
    if (!element.parentNode) {
        return false;
    }
    if (element == document.body) {
        return true;
    }
    return hasParent(element.parentNode);
}
