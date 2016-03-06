/**
 * Copyright 2016 IBM Corp.
 *
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
 **/

module.exports = function(RED) {
    "use strict";
    var fs = require('fs');
    var spawn = require('child_process').spawn;
    var colours = require('./colours');

    var hatCommand = __dirname+'/sensehat';

    if ( !(1 & parseInt ((fs.statSync(hatCommand).mode & parseInt ("777", 8)).toString (8)[0]) )) {
        RED.log.error(hatCommand + " command is not executable");
        throw "Error : "+RED._("node-red:rpi-gpio.errors.mustbeexecutable");
    }

    // the magic to make python print stuff immediately
    process.env.PYTHONUNBUFFERED = 1;

    // Xaccel.x,y,z,gyro.x,y,z,orientation.roll,pitch,yaw,compass
    var HF_RE = /^X(.+),(.+),(.+),(.+),(.+),(.+),(.+),(.+),(.+),(.+)$/;
    //  Ytemperature,humidity,pressure
    var LF_RE = /^Y(.+),(.+),(.+)$/;
    //  K[U|L|R|D|E][0|1|2] - joystick event:  direction,state
    var KEY_RE = /^K(.)(.)$/;
    var KEY_MAP = {
        "U":"UP",
        "D":"DOWN",
        "L":"LEFT",
        "R":"RIGHT",
        "E":"ENTER"
    };

    var HAT = (function() {
        var hat = null;
        var onclose = null;
        var users = [];
        var motionUsers = 0;
        var envUsers = 0;
        var reconnectTimer = null;

        var connect = function() {
            var buffer = "";
            hat = spawn(hatCommand);
            hat.stdout.on('data', function (data) {
                buffer += data.toString();
                var lines = buffer.split("\n");
                if (lines.length == 1) {
                    return;
                }
                buffer = lines.pop();
                var m,msg;
                for (var i=0;i<lines.length;i++) {
                    var line = lines[i];
                    msg = null;
                    if ((m = KEY_RE.exec(line)) !== null) {
                        msg = {
                            topic: "joystick",
                            payload: {key: KEY_MAP[m[1]], state: Number(m[2])}
                        }
                    } else if ((m = LF_RE.exec(line)) !== null) {
                        msg = {
                            topic: "environment",
                            payload: {temperature: Number(m[1]), humidity: Number(m[2]), pressure: Number(m[3])}
                        }
                    } else if ((m = HF_RE.exec(line)) !== null) {
                        // Xaccel.x,y,z,gyro.x,y,z,orientation.roll,pitch,yaw,compass
                        msg = {
                            topic: "motion",
                            payload: {
                                acceleration: {
                                    x: Number(m[1]),
                                    y: Number(m[2]),
                                    z: Number(m[3])
                                },
                                gyroscope: {
                                    x: Number(m[4]),
                                    y: Number(m[5]),
                                    z: Number(m[6])
                                },
                                orientation: {
                                    roll: Number(m[7]),
                                    pitch: Number(m[8]),
                                    yaw: Number(m[9])
                                },
                                compass: Number(m[10])
                            }
                        }
                    }
                    if (msg && !onclose) {
                        for (var j=0;j<users.length;j++) {
                            var node = users[j];
                            if (node.motion && msg.topic === "motion") {
                                node.send(RED.util.cloneMessage(msg));
                            } else if (node.env && msg.topic === 'environment') {
                                node.send(RED.util.cloneMessage(msg));
                            } else if (node.stick && msg.topic === 'joystick') {
                                node.send(RED.util.cloneMessage(msg));
                            }
                        }
                    }
                }
            });
            hat.stderr.on('data', function (data) {
                if (RED.settings.verbose) { RED.log.error("err: "+data+" :"); }
            });
            hat.stderr.on('error', function(err) { });
            hat.stdin.on('error', function(err) { });

            hat.on('close', function (code) {
                hat = null;
                users.forEach(function(node) {
                    node.status({fill:"red",shape:"ring",text:"node-red:common.status.disconnected"});
                });
                if (RED.settings.verbose) { RED.log.info(RED._("node-red:rpi-gpio.status.closed")); }
                if (onclose) {
                    onclose();
                    onclose = null;
                } else {
                    reconnectTimer = setTimeout(function() {
                        connect();
                    },5000);
                }
            });

            hat.on('error', function (err) {
                if (err.errno === "ENOENT") { RED.log.error(RED._("node-red:rpi-gpio.errors.commandnotfound")); }
                else if (err.errno === "EACCES") { RED.log.error(RED._("node-red:rpi-gpio.errors.commandnotexecutable")); }
                else {
                    RED.log.error(RED._("node-red:rpi-gpio.errors.error")+': ' + err.errno);
                }
            });

            if (motionUsers > 0) {
                hat.stdin.write('X1\n');
            }
            if (envUsers > 0) {
                hat.stdin.write('Y1\n');
            }

        }

        var disconnect = function(done) {
            if (hat !== null) {
                onclose = done;
                hat.kill('SIGKILL');
                hat = null;
            }
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
            }

        }


        return {
            open: function(node) {
                if (!hat) {
                    connect();
                }
                if (!reconnectTimer) {
                    node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
                }

                if (node.motion) {
                    if (motionUsers === 0) {
                        hat.stdin.write('X1\n');
                    }
                    motionUsers++;
                }
                if (node.env) {
                    if (envUsers === 0) {
                        hat.stdin.write('Y1\n');
                    }
                    envUsers++;
                }
                users.push(node);
            },
            close: function(node,done) {
                if (node.motion) {
                    motionUsers--;
                    if (motionUsers === 0) {
                        hat.stdin.write('X0\n');
                    }
                }
                if (node.env) {
                    envUsers--;
                    if (envUsers === 0) {
                        hat.stdin.write('Y0\n');
                    }
                }
                users.splice(users.indexOf(node),1);
                if (users.length === 0) {
                    disconnect(done);
                } else {
                    done();
                }
            },
            send: function(msg) {
                if (hat) {
                    hat.stdin.write(msg+'\n');
                }
            }
        }
    })();


    function SenseHatInNode(n) {
        RED.nodes.createNode(this,n);
        this.motion = n.motion;
        this.env = n.env;
        this.stick = n.stick;
        var node = this;
        node.status({fill:"red",shape:"ring",text:"node-red:common.status.disconnected"});
        HAT.open(this);

        node.on("close", function(done) {
            HAT.close(this,done);
        });
    }
    RED.nodes.registerType("rpi-sensehat in",SenseHatInNode);

    function SenseHatOutNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        node.status({fill:"red",shape:"ring",text:"node-red:common.status.disconnected"});

        HAT.open(this);

        node.on("close", function(done) {
            HAT.close(this,done);
        });
        var handleTextMessage = function(line,msg) {
            var textCol = colours.getRGB(msg.color||msg.colour)||"255,255,255";
            var backCol = colours.getRGB(msg.background)||"0,0,0";
            var speed = null;
            if (!isNaN(msg.speed)) {
                speed = msg.speed;
            }
            var command = "T";
            if (textCol) {
                command += textCol;
                if (backCol) {
                    command += ","+backCol;
                }
            }

            if (speed) {
                var s = parseInt(speed);
                if (s >= 1 && s <= 5) {
                    s = 0.1 + (3-s)*0.03;
                }
                command = command + ((command.length === 1)?"":",") + s;
            }
            command += ":" + line;
            return command;
        }

        node.on("input",function(msg) {
            var command;
            var parts;
            var col;
            if (typeof msg.payload === 'number') {
                HAT.send(handleTextMessage(""+msg.payload,msg));
            } else if (typeof msg.payload === 'string') {
                var lines = msg.payload.split("\n");
                lines.forEach(function(line) {
                    command = null;
                    col = colours.getRGB(line);
                    if ( /^(([0-7]|\*),([0-7]|\*),(\d{1,3},\d{1,3},\d{1,3}|#[a-f0-9]{3,6}|[a-z]+))(,([0-7]|\*),([0-7]|\*),(\d{1,3},\d{1,3},\d{1,3}|#[a-f0-9]{3,6}|[a-z]+))*$/i.test(line)) {
                        parts = line.split(",");
                        var expanded = [];
                        var i=0;
                        var j=0;
                        while (i<parts.length) {
                            var x = parts[i++];
                            var y = parts[i++];
                            col = parts[i++];
                            if (/#[a-f0-9]{3,6}|[a-z]/i.test(col)) {
                                col = colours.getRGB(col);
                                if (col === null) {
                                    // invalid colour, go no further
                                    return;
                                }
                            } else {
                                col += ","+parts[i++]+","+parts[i++];
                            }
                            if (x!=='*' && y!=='*') {
                                expanded.push([x,y,col]);
                            } else if (x == '*' && y == '*') {
                                for (j=0;j<8;j++) {
                                    for (var k=0;k<8;k++) {
                                        expanded.push([j,k,col]);
                                    }
                                }
                            } else if (x == '*') {
                                for (j=0;j<8;j++) {
                                    expanded.push([j,y,col]);
                                }
                            } else if (y == '*') {
                                for (j=0;j<8;j++) {
                                    expanded.push([x,j,col]);
                                }
                            }
                        }
                        if (expanded.length > 0) {
                            var pixels = {};
                            var rules = [];
                            for (i=expanded.length-1;i>=0;i--) {
                                var rule = expanded[i];
                                if (!pixels[rule[0]+","+rule[1]]) {
                                    rules.unshift(rule.join(","));
                                    pixels[rule[0]+","+rule[1]] = true;
                                }
                            }
                            if (rules.length > 0) {
                                command = "P"+rules.join(",");
                            }
                        }
                    }


                    if (!command) {
                        if (/^R(0|90|180|270)$/i.test(line)) {
                            command = line.toUpperCase();
                        } else if (/^F(H|V)$/i.test(line)) {
                            command = line.toUpperCase();
                        } else if (/^D(0|1)$/i.test(line)) {
                            command = line.toUpperCase();
                        } else {
                            command = handleTextMessage(line,msg);
                        }
                    }
                    if (command) {
                        //console.log(command);
                        HAT.send(command);
                    }
                });
            }
        });
    }
    RED.nodes.registerType("rpi-sensehat out",SenseHatOutNode);

}
