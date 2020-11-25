'use strict';

// This file contains everything related to connecting devices: wires, pins,
// buses, etc.

// A pin is a single connection on the outside of a device. It can for example
// be a leg on a LED or a header pin on a board.
class Pin {
    constructor(device, data) {
        this.device = device;
        this.data = data;
        this.mode = data.mode || 'input';
        this.high = false;
        this.spans = [];
        this.connectedOnBoard = new Set([this]); // connected together on a single development board
        this.connectionCache = null;
        this.connectionCacheVersion = 0;
        this.wires = new Set(); // wires between development boards or independent electronics

        // The pin uses one or two elements.
        // - When data.svgId is set, the background SVG for the device (normally
        //   a board) will be loaded and the element with that ID will be set to
        //   this.backgroundElement. this.element will then be a very small
        //   invisible square just enough for wires to know where to position
        //   themselves.
        // - Otherwise (and normally) data.svgId is not set, meaning that
        //   this.backgroundElement remains null and this.element is the element
        //   that is used for presentation of this pin.
        this.element = null;
        this.backgroundElement = null;

        this.updateShape();
    }

    // Reset this pin to the initial power-on state.
    reset() {
        this.mode = this.data.mode || 'input';
        this.high = false;
        this.update();
    }

    get name() {
        return this.data.name;
    }

    get humanName() {
        return this.device.name + ' ' + this.data.name;
    }

    get connected() {
        if (this.connectionCache !== null && this.connectionCacheVersion == wireConfigurationVersion) {
            return this.connectionCache;
        }

        let uncheckedWires = new Set();
        let checkedWires = new Set();

        // Start out with all the pins that are directly connected together (on
        // a single development board).
        let connected = new Set();
        for (let pin of this.connectedOnBoard.keys()) {
            connected.add(pin);
            for (let wire of pin.wires) {
                uncheckedWires.add(wire);
            }
        }

        while (uncheckedWires.size) {
            // Pick one of the wires.
            let wire;
            for (let w of uncheckedWires) {
                wire = w;
            }

            // Mark it as checked.
            uncheckedWires.delete(wire);
            checkedWires.add(wire);

            // Add both pins at the ends of this wire.
            for (let pin of [wire.from, wire.to]) {
                for (let pinOnBoard of pin.connectedOnBoard) {
                    connected.add(pinOnBoard);
                }
                for (let pinWire of pin.wires) {
                    if (!checkedWires.has(pinWire)) {
                        uncheckedWires.add(pinWire);
                    }
                }
            }
        }

        this.connectionCacheVersion = wireConfigurationVersion;
        this.connectionCache = connected;
        return connected;
    }

    // isHigh returns true if this pin is high, false if it's low or floating.
    isHigh() {
        for (let pin of this.connected) {
            if (pin.mode == 'output') {
                return pin.high; // high or low
            }
        }
        return false; // floating
    }

    // isLow returns true if this pin is low, false if it's high or floating.
    isLow() {
        for (let pin of this.connected) {
            if (pin.mode == 'output') {
                return !pin.high; // high or low
            }
        }
        return false; // floating
    }

    setMode(mode) {
        this.mode = mode;
        this.update();
    }

    set(high) {
        this.high = high;
        this.update();
    }

    update() {
        for (let span of this.spans) {
            if (!hasParent(span)) {
                this.spans = this.spans.filter(sp => sp !== span);
                continue;
            }
            this.updateSpan(span);
        }

        for (let pin of this.connected.keys()) {
            pin.device.onPinChange(pin);
        }
    }

    updateShape() {
        // Remove old element if present.
        if (this.element) {
            this.element.remove();
            this.element = undefined;
        }

        // Create new element if needed.
        if ('x' in this.data && 'y' in this.data) {
            this.element = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            let size = 2;
            if (this.data.svgId) {
                // See the class constructor for an explanation.
                // Size can't be 0 otherwise getBoundingClientRect (to determine
                // wire location) won't work.
                size = 0.001;
                this.element.style.fill = 'transparent';
            }
            this.element.style.width = size+'mm';
            this.element.style.height = size+'mm';
            this.element.style.x = (this.data.x - size/2) + 'mm';
            this.element.style.y = (this.data.y - size/2) + 'mm';
            this.element.classList.add('pin');
            this.device.element.appendChild(this.element);
        }

        // Layout all wires connected to the device.
        for (let wire of this.wires) {
            wire.layout();
        }
    }

    updateSpan(span) {
        span.setAttribute('data-mode', this.mode);
        span.classList.toggle('output-high', this.high)
    }

    createPinSpan() {
        let span = document.createElement('span');
        span.textContent = this.humanName;
        span.classList.add('pin');
        this.updateSpan(span);
        this.spans.push(span);
        return span;
    }
}

// A wire connects two pins together, forming an electrical connection.
class Wire {
    constructor(play, data) {
        this.data = data;

        // Create the element.
        this.element = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        this.element.classList.add('wire');

        // Add the wire to the pins.
        this.from = play.objects[data.from.id].obj.getPinByName(data.from.pin);
        if (data.to) {
            // Both from and to are set, which means that it's a regular wire
            // (not a wire being added at the moment).
            this.to = play.objects[data.to.id].obj.getPinByName(data.to.pin);
            if (!this.from || !this.to) {
                // Special case.
                // While both from and to are set, at least one is not present
                // at the moment. This can happen when the main board has been
                // changed and this wire is attached to a pin that existed on
                // the old board but doesn't exist on the new board.
                // Deal with this by not adding this wire to the pins and hiding
                // the SVG line object.
                this.element.style.display = 'none';
                return;
            }
            this.to.wires.add(this);
        } else {
            // This wire is still being created: the first pad (from) has been
            // clicked but the second pad (to) hasn't yet.
            this.to = null;
        }
        this.from.wires.add(this);
    }

    layout() {
        if (this.element.style.display == 'none') {
            // One of the attached pins does not exist, the wire isn't shown, so
            // don't bother laying it out.
            return;
        }

        let fromRect = this.from.element.getBoundingClientRect();
        let x1 = fromRect.x+fromRect.width/2;
        let y1 = fromRect.y+fromRect.height/2;
        let x2;
        let y2;

        if (this.to) {
            // Regular wire.
            let toRect = this.to.element.getBoundingClientRect();
            x2 = toRect.x+toRect.width/2;
            y2 = toRect.y+toRect.height/2;
        } else {
            // Wire that is being added. x2 and y2 should be close to the mouse
            // pointer, but not exactly under it.
            let x = this.mouseX - x1;
            let y = this.mouseY - y1;
            let length = Math.sqrt(x*x + y*y); // Pythagoras
            // Make sure the line doesn't go all the way to the pointer so that
            // hover still works.
            let reduceX = (5 * x / length);
            let reduceY = (5 * y / length);
            x2 = this.mouseX - reduceX;
            y2 = this.mouseY - reduceY;
        }

        this.element.setAttribute('x1', x1);
        this.element.setAttribute('y1', y1);
        this.element.setAttribute('x2', x2);
        this.element.setAttribute('y2', y2);
    }

    remove() {
        // Calling 'remove' is not enough to remove the wire completely, see
        // Play.removeWire.
        this.element.remove();
        this.from.wires.delete(this);
        if (this.to) {
            this.to.wires.delete(this);
        }
    }

    // setTo sets the second pin this wire is attached to. This is used when
    // adding a new wire and the second pin is clicked. It finalizes the
    // creation of the wire.
    setTo(pin) {
        delete this.mouseX;
        delete this.mouseY;
        this.to = pin;
        this.to.wires.add(this);
        this.data.to = {
            id: pin.device.id,
            pin: pin.name,
        }
        this.layout();
    }
}

// SPIController is a SPI controller, usually used on a microcontroller to
// control peripherals.
class SPIController {
    constructor() {
        this.sck = null;
        this.sdo = null;
        this.sdi = null;
    }

    configure(sck, sdo, sdi) {
        this.sck = sck;
        this.sdo = sdo;
        this.sdi = sdi;
    }

    transfer(b) {
        for (let pin of this.sck.connected) {
            if ('transferSPI' in pin.device) {
                pin.device.transferSPI(b, this.sck, this.sdo, this.sdi);
                // TODO: receive data back.
            }
        }
    }
}
