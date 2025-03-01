import React, {
    createRef,
} from "react";

import io from "socket.io-client";
import { nanoid } from 'nanoid';
import AudioEngine from 'scratch-audio';
import { compose } from 'redux';
import { connect } from 'react-redux';
import { injectIntl } from 'react-intl';

import vmListenerHOC from '../lib/vm-listener-hoc.jsx';
import vmManagerHOC from '../lib/vm-manager-hoc.jsx';
import VMScratchBlocks from '../lib/blocks';

import Box from '../components/box/box.jsx';
import ScreenCaptureOutput from '../containers/screen-capture-output.jsx';
import ScreenCaptureThumbnail from '../containers/screen-capture-thumbnail.jsx';
import StageWrapper from '../containers/stage-wrapper.jsx';
import { STAGE_DISPLAY_SIZES } from '../lib/layout-constants.js';

const socketRef = createRef();
const studentVideoFullScreen = createRef();
const activeStudent = createRef();
const connectingStudent = createRef();
const peerRef = createRef();
const dataChannel = createRef();

const studentVideos = {};
const studentWorkspaceRefs = {};
const studentNames = {};
var studentProjectData = {};

//Generate a random room ID
const roomID = nanoid();

class ClassroomGUI extends React.Component {
    constructor(props) {
        super(props);
        this.state = { studentVideos: {}, activeVideo: null }

        this.activeProject = null;
        this.loaded = false;

        this.handleRecieveCall = this.handleRecieveCall.bind(this);
        this.handleUserJoin = this.handleUserJoin.bind(this);
        this.handleNewICECandidateMsg = this.handleNewICECandidateMsg.bind(this);
        this.loadProject = this.loadProject.bind(this);
    }

    componentDidMount() {
        this._isMounted = true;

        this.ScratchBlocks = VMScratchBlocks(this.props.vm);
        this.props.vm.attachAudioEngine(new AudioEngine());

        socketRef.current = io('http://localhost:8000');
        socketRef.current.emit('create room', roomID);

        socketRef.current.on('user joined', this.handleUserJoin);

        socketRef.current.on('offer', this.handleRecieveCall);

        socketRef.current.on('ice-candidate', this.handleNewICECandidateMsg);

        this.displayThumbnailView();
    };

    componentWillUnmount() {
        console.log('unmounting');
        this._isMounted = false;
    };

    /**
     * Respond to a student joining a room.
     * @param {*} userData Contains the ID and name of the student joining the room.
     */
    handleUserJoin(userData) {
        connectingStudent.current = userData.id;
        studentNames[userData.id] = userData.name;
    };

    /**
     * Respond to incoming call request
     * @param {*} incoming 
     */
    handleRecieveCall(incoming) {
        peerRef.current = this.createPeer();
        peerRef.current.addEventListener('datachannel', event => {
            dataChannel.current = event.channel;
            dataChannel.current.addEventListener('message', (event) => {
                this.onMessageReceived(event);
            })
        });
        const desc = new RTCSessionDescription(incoming.sdp);
        peerRef.current.setRemoteDescription(desc).then(() => {
            return peerRef.current.createAnswer();
        }).then(answer => {
            return peerRef.current.setLocalDescription(answer);
        }).then(() => {
            const payload = {
                target: incoming.caller,
                caller: socketRef.current.id,
                sdp: peerRef.current.localDescription
            }
            socketRef.current.emit('answer', payload);
        });
    };

    /**
     * Respond to incoming message on the datachannel
     * @param {} event Object representing the message event
     */
    onMessageReceived(event) {
        if (typeof event.data === 'string') {
            // handle incoming alert for number of bytes in project
            if (parseInt(event.data)) {
                this.onChunkNumberReceived(event);
            }
            // handle incoming blocks JSON string message
            else {
                this.onWorkspaceXmlReceived(event);
            }
        }
        // handle incoming project to be loaded in the renderer
        else if (event.data instanceof ArrayBuffer) {
            this.onArrayBufferReceived(event);
        }
        else {
            console.log(event.data);
            console.log(typeof event.data);
        }
    }

    /**
     * On receiving a JSON string as a message, decode the xml and and add blocks to workspace
     * @param {*} event 
     */
    onWorkspaceXmlReceived(event) {
        const eventObject = JSON.parse(event.data);

        // create new workspace for student if necessary
        if (!studentWorkspaceRefs[eventObject.sender]) {
            studentWorkspaceRefs[eventObject.sender] = createRef();
        }

        // update workspace thumbnail with the new blocks list and re-render
        studentWorkspaceRefs[eventObject.sender].current = eventObject.xml;
        if (this._isMounted) {
            this.setState({ studentVideos: studentWorkspaceRefs, activeVideo: this.state.activeVideo })
        }
    }

    /**
     * On receiving the number of bytes in the project, prepare to receive the project data in chunks
     * @param {*} event 
     */
    onChunkNumberReceived(event) {
        studentProjectData = { total: parseInt(event.data), bytesReceived: 0, dataReceived: new Uint8Array() };
    }

    /**
     * Combine all chunks of the project into a single ArrayBuffer and store it to be loaded later
     * @param {*} event 
     */
    onArrayBufferReceived(event) {

        // combine the chunk that was just received with all the previous chunks
        var chunkArray = new Uint8Array(event.data);
        var prevData = studentProjectData.dataReceived;

        studentProjectData.dataReceived = new Uint8Array([
            ...prevData,
            ...chunkArray
        ]);

        studentProjectData.bytesReceived += event.data.byteLength;

        // convert data back to ArrayBuffer if all data has been received
        if (studentProjectData.bytesReceived == studentProjectData.total) {
            this.activeProject = studentProjectData.dataReceived.buffer;
            if (!this.loaded) {
                this.loadProject();
            }
        }

    }

    /**
     * load the most recently stored project into the renderer.
     */
    loadProject() {
        this.loaded = true;
        this.props.vm.loadProject(this.activeProject);
    }

    /**
     * create a peer connection with the student
     * @returns RTCPeerConnection
     */
    createPeer() {
        const peer = new RTCPeerConnection({
            iceServers: [
                {
                    urls: "stun:stun.stunprotocol.org"
                },
                {
                    urls: 'turn:numb.viagenie.ca',
                    credential: 'muazkh',
                    username: 'webrtc@live.com'
                },
            ]
        });

        peer.onicecandidate = this.handleICECandidateEvent;
        peer.ontrack = this.handleTrackEvent;

        return peer;
    };

    handleICECandidateEvent(e) {
        if (e.candidate) {
            const payload = {
                target: connectingStudent.current,
                candidate: e.candidate,
            }
            socketRef.current.emit("ice-candidate", payload);
        }
    }

    handleNewICECandidateMsg(incoming) {
        const candidate = new RTCIceCandidate(incoming);

        peerRef.current.addIceCandidate(candidate)
            .catch(e => console.log(e));
    };

    handleTrackEvent(e) {
        studentVideos[connectingStudent.current] = e.streams[0];
    };

    /**
     * display the student thumbnails when Show Thumbnails button is clicked
     */
    displayThumbnailView = () => {
        this.loaded = false;

        // send event to student client to stop sharing their project as ArrayBuffer
        if (activeStudent.current) {
            dataChannel.current.send('stop sb3 stream');
        }

        // re-render component
        activeStudent.current = null;
        if (this._isMounted) {
            this.setState({ studentVideos: studentWorkspaceRefs, activeVideo: null });
        }
    }

    /**
     * Display the student's video of their screen and the independent 
     * renderer with their project loaded
     */
    displayStudentVideo = (studentId) => {
        activeStudent.current = studentId;

        // emit event instructing student to start sharing their project ArrayBuffer
        dataChannel.current.send('send project sb3');

        if (this._isMounted) {
            // re-render component
            this.setState({ studentVideos: studentWorkspaceRefs, activeVideo: studentId }, () => {
                studentVideoFullScreen.current.srcObject = studentVideos[studentId];
            });
        }
    }

    /**
     * Transfer any mouse clicks on student's video screenshare to the student client
     * @param {*} event Details of the mouse event including x and y location of the click
     */
    handleClick = (event) => {
        const video = document.getElementById('video');
        video.focus();

        this.handleMouseEvent(event, 'click');
    }

    handleMouseDown = (event) => {
        this.handleMouseEvent(event, 'mousedown');

    }

    handleMouseUp = (event) => {
        this.handleMouseEvent(event, 'mouseup');
    }

    handleDrag(event) {
        this.handleMouseEvent(event, 'mousemove');
    }

    handleDragStart(event) {
        event.dataTransfer.setDragImage(new Image(), 0, 0);
    }

    handleDragEnd(event) {
        this.handleMouseUp(event);
    }

    handleMouseEvent(event, name) {
        const clickLocation = this.getClickProportion(event);

        var event = {
            type: 'mouse',
            studentID: activeStudent.current,
            x: clickLocation.x,
            y: clickLocation.y,
            name: name
        };

        var json = JSON.stringify(event);

        dataChannel.current.send(json);
    }

    /**
     * Calculate the x and y location of a mouse event as a fraction of the size of the video
     * For example, a click in the middle of the video returns { x: 0.5, y: 0.5 }
     * @param {*} event Details of the mouse event including the x and y 
     * location of where the event occurred
     * @returns Object storing the fraction x and y values
     */
    getClickProportion = (event) => {
        const video = document.getElementById('video');

        const dimensions = video.getBoundingClientRect();

        const xProportion = (event.clientX - dimensions.x) / dimensions.width;
        const yProportion = (event.clientY - dimensions.y) / dimensions.height;

        return ({ x: xProportion, y: yProportion });
    }

    handleKeyPress(event) {
        const keyEvent = event.nativeEvent;

        var event = {
            type: 'key',
            studentID: activeStudent.current,
            key: keyEvent.key,
            code: keyEvent.code
        }

        var json = JSON.stringify(event);

        dataChannel.current.send(json);
    }

    handleWheel(event) {
        const scrollLocation = this.getClickProportion(event);

        var event = {
            type: 'wheel',
            studentID: activeStudent.current,
            x: scrollLocation.x,
            y: scrollLocation.y,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            deltaZ: event.deltaZ,
            deltaMode: event.deltaMode
        }

        var json = JSON.stringify(event);

        dataChannel.current.send(json);

    }

    render() {
        this.visible = (this.props.visible == 'classroom');
        var videoDisplay;

        // Either render all student thumbnails, or render the selected student's video and renderer
        if (this.state.activeVideo == null) {
            var videos = [];
            for (let key in this.state.studentVideos) {
                videos.push(
                    <ScreenCaptureThumbnail
                        key={key}
                        name={studentNames[key]}
                        xml={this.state.studentVideos[key].current}
                        onClick={() => this.displayStudentVideo(key)}
                        ScratchBlocks={this.ScratchBlocks}
                        vm={this.props.vm}
                    >
                    </ScreenCaptureThumbnail>
                )
            }
            videoDisplay = videos;
        }
        else {
            videoDisplay =
                <div>
                    <ScreenCaptureOutput
                        video={studentVideoFullScreen}
                        onClick={(e) => this.handleClick(e)}
                        onMouseDown={(e) => this.handleMouseDown(e)}
                        onMouseUp={(e) => this.handleMouseUp(e)}
                        onDrag={(e) => this.handleDrag(e)}
                        onDragStart={(e) => this.handleDragStart(e)}
                        onDragEnd={(e) => this.handleDragEnd(e)}
                        onKeyDown={(e) => this.handleKeyPress(e)}
                        onWheel={(e) => this.handleWheel(e)}>
                    </ScreenCaptureOutput>
                    <button onClick={this.loadProject}>Refresh Renderer</button>
                    <StageWrapper
                        isRendererSupported={true}
                        isFullScreen={false}
                        stageSize={STAGE_DISPLAY_SIZES.large}
                        vm={this.props.vm}
                        isRtl={false}
                    />

                </div>
        }

        return (
            this.visible ?
                <Box>
                    <button onClick={this.displayThumbnailView}>Show Thumbnails</button>
                    <button onClick={() => this.props.setGuiState('blocks')}>Back to Scratch</button>
                    <div>
                        {
                            videoDisplay
                        }
                    </div>
                    <p>Room ID: {roomID}</p>
                </Box> : null
        );

    }
}

const mapStateToProps = state => {
    return {
        isPlayerOnly: state.scratchGui.mode.isPlayerOnly,
        vm: state.scratchGui.vm
    }
}

const ConnectedGUI = injectIntl(connect(
    mapStateToProps
)(ClassroomGUI));

const WrappedGui = compose(
    vmListenerHOC,
    vmManagerHOC,
)(ConnectedGUI);

export default WrappedGui;