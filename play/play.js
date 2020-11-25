'use strict';

const objectBorderSize = 2;

// This is a fallback that should not normally be used.
const defaultDevice = 'arduino';

// Global number that is incremented each time something has changed about the
// wires. It means that all cached connections need to be re-generated.
var wireConfigurationVersion = 1;

// Get the VS Code API if available.
var vscode = null;
try {
    vscode = acquireVsCodeApi();
} catch(e) {}

class Play {
    constructor(data) {
        this.data = data;
        this.viewport = document.querySelector('#viewport');
        this.info = document.querySelector('#info');
        this.objects = {};
        this.wires = [];

        // Handle clicks on info panel tabs.
        for (let tab of document.querySelectorAll('.tab[data-for]')) {
            tab.addEventListener('click', (e) => {
                e.preventDefault();

                e.target.parentNode.querySelector('.tab.selected').classList.remove('selected');
                e.target.classList.add('selected');

                let content = document.querySelector(e.target.dataset.for);
                content.parentNode.querySelector('.tabcontent.selected').classList.remove('selected');
                content.classList.add('selected');
            })
        }

        // Zoom using the scroll wheel.
        this.scale = 1;
        this.scaleAnimationFrame = null;
        this.viewport.addEventListener('wheel', (e) => {
            let deltaY = e.deltaY;
            if (e.deltaMode == WheelEvent.DOM_DELTA_PIXEL) {
                deltaY = e.deltaY / 22;
            }
            this.scale = Math.min(Math.max(this.scale * (1 - deltaY * 0.02), 0.2), 5);
            // Do the update in a requestAnimationFrame callback, and only when
            // this hasn't been queued already. This should avoid additional
            // jankyness when zooming.
            if (!this.scaleAnimationFrame) {
                this.scaleAnimationFrame = requestAnimationFrame(() => {
                    this.scaleAnimationFrame = null;
                    for (let id in this.objects) {
                        this.layoutObject(this.objects[id].obj, true);
                    }
                    for (let wire of this.wires) {
                        wire.layout();
                    }
                })
            }
        });

        // Selection and dragging of objects.
        // Moving objects can be done in two ways: by dragging them (moveMode ==
        // 'drag') and after newly adding them. In the former case the mouse
        // must be kept down as long as the drag is in progress, and when it is
        // lifted it will stop. In the latter case the mouse does not need to be
        // down.
        viewport.addEventListener('click', (e) => {
            this.deselect();
        });
        this.selected = null;
        this.moveMode = ''; // '', 'drag', 'add', or 'add-wire'
        viewport.addEventListener('mousemove', (e) => {
            if (this.moveMode == 'drag' && (e.buttons & 1) == 0) {
                // Not dragging anything.
                this.moveMode = '';
                this.save();
                return;
            }
            if (!this.selected) return;
            if (this.moveMode == 'drag' || this.moveMode == 'add') {
                let x = e.pageX - this.shiftX;
                let y = e.pageY - this.shiftY;
                x = Math.max(x, (objectBorderSize+1)*this.scale);                   // bound to the left
                x = Math.min(x, viewport.clientWidth-mm2px(this.selected.width));   // bound to the right
                y = Math.max(y, (objectBorderSize+1)*this.scale);                   // bound to the top
                y = Math.min(y, viewport.clientHeight-mm2px(this.selected.height)); // bound to the bottom
                this.selected.properties.x = x / this.scale;
                this.selected.properties.y = y / this.scale;
                this.layoutObject(this.selected);
                for (let wire of this.wires) {
                    wire.layout();
                }
            } else if (this.moveMode == 'add-wire') {
                this.selected.mouseX = e.clientX;
                this.selected.mouseY = e.clientY;
                this.selected.layout();
            }
        });

        // Make it possible to add devices from the dropdown button in the top
        // right.
        for (let el of document.querySelectorAll('#add-device-dropdown .device')) {
            el.addEventListener('click', async (e) => {
                // Hide the dropdown.
                let addDeviceBtn = document.querySelector('#add-device');
                addDeviceBtn.style.pointerEvents = 'none';
                setTimeout(() => {
                    addDeviceBtn.style.pointerEvents = '';
                }, 100)

                let properties = {
                    id: 'obj-' + Math.random().toString(16).substr(2, 12),
                    type: el.dataset.type,
                    x: e.clientX,
                    y: e.clientY,
                }
                let obj = await this.addObject(properties);
                this.select(obj);

                // TODO: put the shiftX and shiftY in the middle of the object.
                this.moveMode = 'add';
                this.shiftX = 0;
                this.shiftY = 0;

                this.data.objects.push(properties);
            })
        }

        // Respond to key events.
        document.addEventListener('keydown', (e) => {
            if (e.key == 'Escape' && this.selected) {
                // Unfocus.
                this.deselect();
            } else if (e.key == 'Delete' && this.selected) {
                let obj = this.selected;
                this.deselect();
                this.removeObject(obj);
            }
        })
    }

    async initObjects() {
        for (let objData of this.data.objects) {
            await this.addObject(objData);
        }

        for (let data of (this.data.wires || [])){
            let wire = this.addWire(data);
            wire.layout();
        }

        wireConfigurationVersion++;
    }

    async addObject(objData) {
        // Create a wrapper layer for the object itself and the outline.
        let wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        wrapper.classList.add('device-wrapper');
        this.viewport.querySelector(':scope > .objects').appendChild(wrapper);

        // Create an outline to show when the object is selected.
        let outline = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        outline.classList.add('outline');
        outline.style.x = (-0.5 * objectBorderSize - 1) + 'px';
        outline.style.y = (-0.5 * objectBorderSize - 1) + 'px';
        wrapper.appendChild(outline);

        // Create the object.
        let obj = await createObject(this, objData);
        wrapper.appendChild(obj.element);

        // Create an overlay layer to put all overlay (pads and labels) DOM
        // nodes in, for convenience. It allows moving all those objects at
        // once.
        let overlay = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        overlay.classList.add('overlay');
        this.viewport.querySelector(':scope > .overlays').appendChild(overlay);

        this.objects[obj.id] = {
            obj:     obj,
            outline: outline,
            overlay: overlay,
            pads:    [],
        };

        // Create a small (normally invisible) circle over each pad on the
        // device that a wire can be attached to.
        for (let pin of obj.pins) {
            let pad = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            pad.classList.add('pad');
            overlay.appendChild(pad);
            this.objects[obj.id].pads.push(pad);

            if (!pin.name) {
                // Pins without name cannot be connected to. These can be used
                // for board-internal connections.
                continue;
            }

            let circleRadius = 5;

            // If set, use the background element as a hover mask so that
            // hovering over the entire element will work, not just over the
            // circle.
            if (pin.backgroundElement) {
                // Clone the background element to use as a hover mask.
                let background = pin.backgroundElement.cloneNode();
                pad.appendChild(background);
                background.style.fill = 'transparent';

                // The background element may be scaled differently (because it
                // lives in a separate SVG element) so it needs to be resized to
                // the correct size before use.
                let rect1 = pin.backgroundElement.getBoundingClientRect();
                let rect2 = background.getBoundingClientRect();
                background.style.transform = 'scale(' + (rect1.height / rect2.height) + ')';

                // Limit the circle radius to the size of the element, to avoid
                // hiding other pads with the circle.
                circleRadius = Math.min(circleRadius, Math.min(rect1.width, rect1.height) / 2 * 1.3);
            }

            // Create the circle.
            let circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.classList.add('pad-circle');
            circle.setAttribute('cx', pin.data.x + 'mm');
            circle.setAttribute('cy', pin.data.y + 'mm');
            circle.setAttribute('r', circleRadius);
            pad.appendChild(circle);

            // Create a label when hovering over the circle.
            let padTextLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            padTextLayer.classList.add('pad-text');
            overlay.appendChild(padTextLayer);

            // Create the background for the label.
            let padTextBackground = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            padTextBackground.setAttribute('height', '22px');
            padTextLayer.appendChild(padTextBackground)

            // Create the text in the label (which is the pin name).
            let padText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            padTextLayer.appendChild(padText);
            padText.textContent = pin.name;
            padText.setAttribute('x', '4px');
            padText.setAttribute('y', '17px');

            // Make the background just large enough to cover the text.
            // This has to be done with the label visible, otherwise
            // getComputedTextLength won't work.
            padTextLayer.style.display = 'initial';
            let length = padText.getComputedTextLength();
            padTextLayer.style.display = '';
            padTextLayer.querySelector('rect').setAttribute('width', (length + 8)+'px');

            // Handle when the circle is clicked.
            pad.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.moveMode == 'add-wire') {
                    // Clicked on a pad while adding a wire, hopefully the
                    // second pad.
                    if (this.selected.from == pin) {
                        // The same pad, not the second pad. Cancel the creation
                        // of this wire by deselecting it.
                        this.deselect();
                        return;
                    }
                    this.moveMode = '';
                    // Clicked another pad, so finish this wire by setting the
                    // 'to' pad.
                    this.selected.setTo(pin);
                    wireConfigurationVersion++;
                    pin.update();
                    this.save();
                    return;
                }
                // Clicked on a pad while no wire is being added currently, so
                // start creating a wire.
                // First deselect any object that might still be selected.
                this.deselect();
                // Then create the new wire.
                let data = {
                    from: {
                        id: obj.id,
                        pin: pin.name,
                    },
                    to: null, // to be filled in after the 2nd pin is clicked
                };
                let wire = this.addWire(data);
                this.data.wires.push(data);
                // Let the wire follow the mouse.
                wire.mouseX = e.clientX;
                wire.mouseY = e.clientY;
                this.moveMode = 'add-wire';
                this.shiftX = 0;
                this.shiftY = 0;
                wire.layout();
                this.select(wire);
            })
        }

        this.layoutObject(obj, true);

        // Make the object draggable.
        wrapper.addEventListener('click', (e) => {
            e.stopPropagation();
            this.select(obj);
        });
        wrapper.addEventListener('mousedown', (e) => {
            this.select(obj);
            let rect = outline.getBoundingClientRect();
            this.moveMode = 'drag';
            this.shiftX = e.clientX - rect.left;
            this.shiftY = e.clientY - rect.top;
        });
        wrapper.addEventListener('mouseup', (e) => {
            this.moveMode = '';
            this.save();
        });

        return obj;
    }

    layoutObject(obj, fullLayout) {
        let overlay = this.objects[obj.id].overlay;
        let outline = this.objects[obj.id].outline;

        // Calculate how much the object must be moved (before scaling) to
        // compensate for the rotation.
        let [offsetX, offsetY] = applyRotation(obj.rotation, mm2px(obj.width), mm2px(obj.height));
        offsetX += obj.properties.x || 0;
        offsetY += obj.properties.y || 0;

        // Position the object.
        let transform = 'translate(' + offsetX * this.scale + 'px, ' + offsetY * this.scale + 'px)';
        transform += ' rotate(' + obj.rotation + 'deg)';
        overlay.style.transform = transform;
        outline.style.transform = transform;
        obj.element.style.transform = transform + ' scale(' + this.scale + ')';

        if (!fullLayout) {
            // Positioning is all that's needed with normal drag/drop.
            return;
        }

        // Layout the outline of the object.
        outline.style.width  = (mm2px(obj.width)  * this.scale + (objectBorderSize + 2)) + 'px';
        outline.style.height = (mm2px(obj.height) * this.scale + (objectBorderSize + 2)) + 'px';

        // Layout the pin pads.
        for (let i=0; i<obj.pins.length; i++) {
            let pin = obj.pins[i];
            if (!pin.name) continue; // pin is board-internal
            let pad = this.objects[obj.id].pads[i];
            pad.style.transform = 'scale(' + this.scale + ')';

            let padTextLayer = pad.nextElementSibling;
            // Convert from mm to px by multiplying with (96 / 25.4).
            let x = (pin.data.x * this.scale) * (96 / 25.4);
            let y = (pin.data.y * this.scale) * (96 / 25.4);
            // Move the label a bit to a more convenient location (just outside
            // the pad). This must be done after rotating otherwise it would
            // move in the wrong direction.
            let labelOffsetX = (5 * this.scale) + 2;
            let labelOffsetY = -10;
            // Move the the right position, then rotate the label, then move the
            // label a bit down and to the right.
            padTextLayer.style.transform = 'translate(' + x + 'px, ' + y + 'px) rotate(' + -obj.rotation + 'deg) translate(' + labelOffsetX + 'px, ' + labelOffsetY + 'px)';
        }
    }

    addWire(data) {
        // Create the line.
        let wire = new Wire(this, data);
        this.wires.push(wire);
        this.viewport.querySelector(':scope > .wires').appendChild(wire.element);
        wire.element.addEventListener('click', (e) => {
            e.stopPropagation();
            this.select(wire);
        })
        return wire;
    }

    getObjects() {
        let objects = new Set();
        for (let id in this.objects) {
            let obj = this.objects[id].obj;
            for (let child of obj.getObjects()) {
                objects.add(child);
            }
        }
        return objects;
    }

    // Get the first MCU found in the schematic, or undefined if there is none.
    getMCU() {
        for (let obj of this.getObjects()) {
            if (obj.data.type === 'mcu') {
                return obj;
            }
        }
    }

    // Remove some object, either a device or a wire.
    removeObject(obj) {
        if (obj instanceof Device) {
            if (obj.id == this.data.objects[0].id) {
                // Do not delete the first object, which is the central
                // board.
                return;
            }
            obj.element.previousElementSibling.remove();
            obj.element.remove();
            this.objects[obj.id].overlay.remove();
            delete this.objects[obj.id];
            this.data.objects.splice(this.data.objects.indexOf(obj.properties), 1);

            // Delete wires attached to the object.
            let pinsNeedingUpdate = new Set();
            for (let i=0; i<this.wires.length; i++) {
                let wire = this.wires[i];
                if (wire.from.device == obj || wire.to.device == obj) {
                    // A wire to be deleted.
                    pinsNeedingUpdate.add(wire.from);
                    pinsNeedingUpdate.add(wire.to);
                    this.removeWire(wire);
                    i--; // continue with the same index in the next loop
                }
            }
            wireConfigurationVersion++;
            for (let pin of pinsNeedingUpdate) {
                pin.update();
            }
        } else if (obj instanceof Wire) {
            this.removeWire(obj);
            wireConfigurationVersion++;
            obj.from.update();
            obj.to.update();
        }
        this.save();
    }

    removeWire(wire) {
        let i = this.wires.indexOf(wire);
        if (i < 0) throw 'wire to remove not found';
        this.wires.splice(i, 1);
        this.data.wires.splice(i, 1);
        wire.remove();
    }

    select(obj) {
        if (this.selected === obj) return;
        if (this.selected) {
            this.deselect();
        }
        this.selected = obj;
        if (obj instanceof Device) {
            obj.element.parentNode.classList.add('selected');
            this.updateInfo();
        } else {
            obj.element.classList.add('selected');
        }
    }

    deselect() {
        if (!this.selected) return;
        if (this.moveMode == 'add-wire') {
            // Deselecting a wire that isn't completed (with just one end
            // connected to a pin pad). Remove this wire as it is not valid.
            this.moveMode = '';
            this.removeWire(this.selected);
        }
        if (this.selected instanceof Device) {
            this.selected.element.parentNode.classList.remove('selected');
        } else {
            this.selected.element.classList.remove('selected');
        }
        this.selected = null;
        this.info.classList.remove('enabled');
    }

    updateInfo() {
        this.info.classList.add('enabled');
        this.info.querySelector('h2').textContent = this.selected.name || '<unknown>';

        // Update devices tab.
        let devicesDiv = this.info.querySelector('#info-devices');
        devicesDiv.innerHTML = '';
        for (let device of this.selected.getObjects()) {
            let contents = device.getHTML();
            if (!contents) continue;

            let nameElement = document.createElement('span');
            nameElement.textContent = device.name;

            devicesDiv.appendChild(nameElement);
            devicesDiv.appendChild(contents);
        }

        // Update pins tab.
        let connectionsDiv = this.info.querySelector('#info-pins');
        connectionsDiv.innerHTML = '';
        for (let pin of this.selected.pins) {
            if (!pin.name) continue; // pin is board-internal
            let spans = [];
            let connectionDiv = document.createElement('div');
            connectionDiv.classList.add('pin-connection');
            connectionsDiv.appendChild(connectionDiv);
            for (let connectedPin of pin.connected) {
                if (connectionDiv.children.length)
                    connectionDiv.appendChild(document.createTextNode('—'));
                let pinSpan = connectedPin.createPinSpan();
                spans.push(pinSpan);
                connectionDiv.appendChild(pinSpan);
            }
            connectionDiv.addEventListener('mouseenter', (e) => {
                for (let p of pin.connected) {
                    if (p.backgroundElement)
                        p.backgroundElement.classList.add('hover');
                    else if (p.element)
                        p.element.classList.add('hover');
                }
                for (let span of spans) {
                    span.classList.add('hover');
                }
            });
            connectionDiv.addEventListener('mouseleave', (e) => {
                for (let p of pin.connected) {
                    if (p.backgroundElement)
                        p.backgroundElement.classList.remove('hover');
                    else if (p.element)
                        p.element.classList.remove('hover');
                }
                for (let span of spans) {
                    span.classList.remove('hover');
                }
            });
        }

        // Update properties tab
        let propertiesDiv = this.info.querySelector('#info-properties');
        propertiesDiv.innerHTML = '';

        // Add rotation property.
        let name = document.createElement('div');
        name.textContent = 'Rotation:';
        propertiesDiv.appendChild(name);

        let div = document.createElement('div');
        propertiesDiv.appendChild(div);

        let select = document.createElement('select');
        for (let rotation of [0, 90, 180, 270]) {
            let option = document.createElement('option');
            option.textContent = rotation + '°';
            option.value = rotation;
            select.appendChild(option);
        }
        select.value = this.selected.properties.rotation || 0;
        select.addEventListener('change', () => {
            this.selected.properties.rotation = parseInt(select.value);
            this.layoutObject(this.selected, true);
            for (let wire of this.wires) {
                wire.layout();
            }
        });
        div.appendChild(select);

        if ('color' in this.selected.properties) {
            let name = document.createElement('div');
            name.textContent = 'Color:';
            propertiesDiv.appendChild(name);

            let input = document.createElement('input');
            input.setAttribute('type', 'color');
            input.value = this.selected.properties.color;
            input.addEventListener('change', () => {
                this.selected.properties.color = input.value;
                this.selected.updateShape();
            });
            propertiesDiv.appendChild(input);
        }

        if ('shape' in this.selected.properties) {
            let name = document.createElement('div');
            name.textContent = 'Size:';
            propertiesDiv.appendChild(name);

            let div = document.createElement('div');
            propertiesDiv.appendChild(div);

            let select = document.createElement('select');
            for (let key in this.selected.shapes) {
                let option = document.createElement('option');
                option.textContent = this.selected.shapes[key].name;
                option.value = key;
                select.appendChild(option);
            }
            select.value = this.selected.properties.shape;
            select.addEventListener('change', () => {
                this.selected.properties.shape = select.value;
                this.selected.updateShape();
                this.layoutObject(this.selected, true);
            });
            div.appendChild(select);
        }
    }

    save() {
        if (vscode) {
            vscode.postMessage({
                command: 'save',
                state: this.data,
            })
        }
    }
}

async function createObject(parent, properties) {
    let data = properties;
    if (properties.type == 'device') {
        let url = 'devices/' + properties.device + '.json';
        data = await (await fetch(url)).json();
    }
    if (data.type && devices[data.type]) {
        let obj = new devices[data.type](parent, properties, data);
        return obj;
    } else if (data.objects) {
        let obj = new Composite(this, properties, data);
        await obj.loadChildren();
        return obj;
    } else {
        console.error('properties:', properties);
        throw 'unknown device';
    }
}

// Convert CSS millimeters to CSS pixels.
// It's important to note here that CSS millimeters have little to do with
// actual on-screen millimeters, but it's somewhat close on most displays.
function mm2px(mm) {
    // Source: https://stackoverflow.com/a/36600437/559350
    return mm * (96 / 25.4);
}

// Return how much the object should be moved before rotation so that it rotates
// in place.
function applyRotation(rotation, width, height) {
    let x = 0;
    let y = 0;
    if (rotation == 90) {
        x = height;
    } else if (rotation == 180) {
        x = width;
        y = height;
    } else if (rotation == 270) {
        y = width;
    }
    return [x, y];
}

async function init() {
    if (vscode) {
        // Running inside VS Code, so start communicating with the TinyGo
        // extension.
        vscode.postMessage({
            command: 'loaded',
        })
        let mcu;
        addEventListener('message', async message => {
            switch (message.data.command) {
            case 'start':
                // This message is sent once after the 'ready' message is
                // received by the extension.
                let state = message.data.state;
                if (!state) {
                    state = {
                        objects: [
                            {
                                type: "device",
                                id: "board",
                                device: message.data.device || defaultDevice,
                                x: 20,
                                y: 10
                            },
                        ],
                        wires: [],
                    }
                }
                if (message.data.device && state.objects[0].device != message.data.device) {
                    // Some other device has been selected. Replace it.
                    state.objects[0].device = message.data.device;
                    // Some wires will point to a pin that doesn't exist on this
                    // board. This is fine, the Wire class knows how to deal
                    // with this case and won't show such wires.
                }
                let play = new Play(state);
                await play.initObjects();
                mcu = play.getMCU();
                vscode.postMessage({
                    command: 'ready',
                    buildTags: mcu.properties.tinygo_buildTags,
                })
            case 'compiling':
                // A new binary is compiling.
                document.body.classList.remove('running');
                break;
            case 'run':
                // Binary has finished compiling, run it now.
                await mcu.runBinary(new Uint8Array(message.data.binary.data), message => {
                    vscode.postMessage({
                        command: 'log',
                        message: message,
                    });
                });
                document.body.classList.add('running');
                break;
            default:
                console.warn('unknown message:', message);
            }
        })
    } else {
        // Not running in the VS Code extension, probably just a webpage.
        let response = await fetch('tinygo-play.json');
        let data = await response.json();
        let play = new Play(data);
        await play.initObjects();
        let mcu = play.getMCU();
        if (mcu.properties.wasm) {
            mcu.runURL(mcu.properties.wasm, message => {
                console.log(message);
            });
            document.body.classList.add('running');
        }
    }
}

init();
