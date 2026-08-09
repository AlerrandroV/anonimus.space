// chat.js - Versão com Sincronização Atômica de Perfil
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js";
import { getDatabase, ref, set, update, push, onValue, get, remove, onChildAdded, onDisconnect, query, limitToFirst } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-database.js";

const firebaseConfig = {
	apiKey: "AIzaSyD7ov1b8hi9vrWiNqGxIUlAbZKtvlt2IY0",
	authDomain: "anonimus-27c23.firebaseapp.com",
	databaseURL: "https://anonimus-27c23-default-rtdb.firebaseio.com",
	projectId: "anonimus-27c23",
	storageBucket: "anonimus-27c23.firebasestorage.app",
	messagingSenderId: "471469525714",
	appId: "1:471469525714:web:a93469102b6b89c18d7b0b",
	measurementId: "G-XL8PYVHSMM"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const rtcConfig = {
	iceServers: [
		{ urls: 'stun:stun.l.google.com:19302' },
		{ urls: 'stun:stun1.l.google.com:19302' }
	]
};

let peerConnection;
let dataChannel;
let currentRoomId = null;
let partnerData = null;

const myDataStr = sessionStorage.getItem('anonimus_my_data');
if (!myDataStr) window.location.href = 'index.html';
const myData = JSON.parse(myDataStr);

const roomsRef = ref(db, 'rooms');
const myGender = myData.gender || 'neutro';
const myInterest = myData.interest || 'neutro';

// ==========================================
// 1. MATCHMAKING
// ==========================================
async function findMatch() {
	setStatus("Procurando alguém...");

	// Se meu interesse é "tanto faz", procuro em todas as pastas de gênero.
	// Caso contrário, procuro só na pasta do gênero que eu quero.
	const gendersToSearch = myInterest === 'neutro'
		? ['masculino', 'feminino', 'neutro']
		: [myInterest];

	for (const targetGender of gendersToSearch) {
		const folderRef = ref(db, `fila_de_espera/${targetGender}`);
		const folderQuery = query(folderRef, limitToFirst(20));
		const snapshot = await get(folderQuery);

		if (!snapshot.exists()) continue;

		const entries = snapshot.val();

		for (const partnerKey of Object.keys(entries)) {
			const partnerInfo = entries[partnerKey];
			const partnerInterest = partnerInfo.interest || 'neutro';

			// Compatibilidade mútua: o parceiro precisa aceitar "tanto faz"
			// ou ter interesse justamente no meu gênero.
			const isCompatible = partnerInterest === 'neutro' || partnerInterest === myGender;

			if (isCompatible) {
				currentRoomId = partnerInfo.roomId;
				partnerData = partnerInfo;

				await remove(ref(db, `fila_de_espera/${targetGender}/${partnerKey}`));
				joinRoom(currentRoomId, partnerInfo);
				return;
			}
		}
	}

	// Ninguém compatível na fila agora: crio minha própria sala e espero
	const newRoomRef = push(roomsRef);
	currentRoomId = newRoomRef.key;
	createRoom(currentRoomId);
}

// ==========================================
// 2. WEBRTC: CALLER (CRIADOR DA SALA)
// ==========================================
async function createRoom(roomId) {
	peerConnection = new RTCPeerConnection(rtcConfig);

	dataChannel = peerConnection.createDataChannel('chat_anonimus');
	setupDataChannel();

	const callerCandidatesRef = ref(db, `rooms/${roomId}/callerCandidates`);
	peerConnection.addEventListener('icecandidate', event => {
		if (event.candidate) push(callerCandidatesRef, event.candidate.toJSON());
	});

	const offer = await peerConnection.createOffer();
	await peerConnection.setLocalDescription(offer);

	const roomRef = ref(db, `rooms/${roomId}`);
	await set(roomRef, {
		offer: { type: offer.type, sdp: offer.sdp },
		callerInfo: myData
	});

	const myQueueRef = push(ref(db, `fila_de_espera/${myGender}`));
	await set(myQueueRef, { roomId: roomId, ...myData });

	onDisconnect(roomRef).remove();
	onDisconnect(myQueueRef).remove();

	onValue(roomRef, snap => {
		const data = snap.val();
		if (!data) return;

		if (data.calleeInfo) {
			partnerData = data.calleeInfo;
			if (dataChannel && dataChannel.readyState === 'open') {
				setPartnerUI(partnerData);
			}
		}

		if (data.answer && !peerConnection.currentRemoteDescription) {
			peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
			setStatus("Conectando...");
		}
	});

	onChildAdded(ref(db, `rooms/${roomId}/calleeCandidates`), data => {
		peerConnection.addIceCandidate(new RTCIceCandidate(data.val()));
	});
}

// ==========================================
// 3. WEBRTC: CALLEE (QUEM ENTRA NA SALA)
// ==========================================
async function joinRoom(roomId, partnerInfo) {
	peerConnection = new RTCPeerConnection(rtcConfig);

	peerConnection.addEventListener('datachannel', event => {
		dataChannel = event.channel;
		setupDataChannel();
	});

	const calleeCandidatesRef = ref(db, `rooms/${roomId}/calleeCandidates`);
	peerConnection.addEventListener('icecandidate', event => {
		if (event.candidate) push(calleeCandidatesRef, event.candidate.toJSON());
	});

	const roomRef = ref(db, `rooms/${roomId}`);
	const roomSnap = await get(roomRef);
	const roomData = roomSnap.val();
	
	if (!roomData || !roomData.offer) {
		setStatus("Erro ao conectar. Pulando...");
		setTimeout(skipPartner, 1500);
		return;
	}

	await peerConnection.setRemoteDescription(new RTCSessionDescription(roomData.offer));

	const answer = await peerConnection.createAnswer();
	await peerConnection.setLocalDescription(answer);

	await update(ref(db, `rooms/${roomId}`), {
		answer: { type: answer.type, sdp: answer.sdp },
		calleeInfo: myData
	});

	setStatus("Conectando...");

	onChildAdded(ref(db, `rooms/${roomId}/callerCandidates`), data => {
		peerConnection.addIceCandidate(new RTCIceCandidate(data.val()));
	});
}

// ==========================================
// 4. TÚNEL P2P E MENSAGERIA
// ==========================================
function setupDataChannel() {
	dataChannel.onopen = () => {
		console.log("CONEXÃO P2P ESTABELECIDA! 🚀");
		
		if (partnerData) {
			setPartnerUI(partnerData);
		} else {
			let checkCount = 0;
			const timer = setInterval(() => {
				checkCount++;
				if (partnerData) {
					setPartnerUI(partnerData);
					clearInterval(timer);
				} else if (checkCount > 10) {
					setPartnerName("Anônimo");
					clearInterval(timer);
				}
			}, 200);
		}

		setTimeout(() => {
			if (currentRoomId) remove(ref(db, `rooms/${currentRoomId}`));
		}, 2000);
	};

	dataChannel.onclose = () => {
		setDisconnectedUI("Desconectado. Pule para achar outro.");
	};

	dataChannel.onmessage = (event) => {
		handleIncomingData(event.data);
	};
}

// ==========================================
// 4.1 PROTOCOLO DE MENSAGENS (texto + áudio + imagem em chunks)
// ==========================================
const incomingAudioBuffers = {};
const incomingImageBuffers = {};

function handleIncomingData(raw) {
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch (err) {
		return; // mensagem em formato inesperado
	}

	switch (payload.type) {
		case 'text':
			printMessage(payload.text, 'received');
			break;

		case 'audio-start':
			incomingAudioBuffers[payload.id] = {
				chunks: new Array(payload.totalChunks),
				duration: payload.duration,
				peaks: payload.peaks,
				mimeType: payload.mimeType || 'audio/webm'
			};
			break;

		case 'audio-chunk': {
			const buf = incomingAudioBuffers[payload.id];
			if (!buf) return;
			buf.chunks[payload.index] = payload.data;
			break;
		}

		case 'audio-end': {
			const buf = incomingAudioBuffers[payload.id];
			if (!buf) return;
			const base64 = buf.chunks.join('');
			const blob = base64ToBlob(base64, buf.mimeType);
			const url = URL.createObjectURL(blob);
			printAudioMessage({ url, duration: buf.duration, peaks: buf.peaks }, 'received');
			delete incomingAudioBuffers[payload.id];
			break;
		}

		case 'image-start':
			incomingImageBuffers[payload.id] = {
				chunks: new Array(payload.totalChunks),
				caption: payload.caption || '',
				mimeType: payload.mimeType || 'image/jpeg'
			};
			break;

		case 'image-chunk': {
			const buf = incomingImageBuffers[payload.id];
			if (!buf) return;
			buf.chunks[payload.index] = payload.data;
			break;
		}

		case 'image-end': {
			const buf = incomingImageBuffers[payload.id];
			if (!buf) return;
			const base64 = buf.chunks.join('');
			const dataUrl = `data:${buf.mimeType};base64,${base64}`;
			printImageMessage(dataUrl, buf.caption, 'received');
			delete incomingImageBuffers[payload.id];
			break;
		}
	}
}

function base64ToBlob(base64, mimeType) {
	const byteChars = atob(base64);
	const byteNumbers = new Array(byteChars.length);
	for (let i = 0; i < byteChars.length; i++) {
		byteNumbers[i] = byteChars.charCodeAt(i);
	}
	return new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
}

function blobToBase64(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => resolve(reader.result.split(',')[1]);
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}

const CHUNK_SIZE = 16000; // caracteres de base64 por pacote enviado (áudio e imagem)

async function sendAudioOverDataChannel(blob, duration, peaks) {
	if (!dataChannel || dataChannel.readyState !== 'open') return;

	const base64 = await blobToBase64(blob);
	const id = `audio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const totalChunks = Math.ceil(base64.length / CHUNK_SIZE);

	dataChannel.send(JSON.stringify({
		type: 'audio-start',
		id,
		duration,
		peaks,
		mimeType: blob.type,
		totalChunks
	}));

	for (let i = 0; i < totalChunks; i++) {
		const chunk = base64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
		dataChannel.send(JSON.stringify({ type: 'audio-chunk', id, index: i, data: chunk }));
	}

	dataChannel.send(JSON.stringify({ type: 'audio-end', id }));
}

function sendImageOverDataChannel(dataUrl, caption, mimeType) {
	if (!dataChannel || dataChannel.readyState !== 'open') return;

	const base64 = dataUrl.split(',')[1];
	const id = `image_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const totalChunks = Math.ceil(base64.length / CHUNK_SIZE);

	dataChannel.send(JSON.stringify({
		type: 'image-start',
		id,
		caption: caption || '',
		mimeType,
		totalChunks
	}));

	for (let i = 0; i < totalChunks; i++) {
		const chunk = base64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
		dataChannel.send(JSON.stringify({ type: 'image-chunk', id, index: i, data: chunk }));
	}

	dataChannel.send(JSON.stringify({ type: 'image-end', id }));
}

const chatInput = document.getElementById('chatInputMessage');
const actionIcon = document.getElementById('actionIcon');
const MAX_LINES = 5;

function autoResizeTextarea() {
	chatInput.style.height = 'auto';
	const lineHeight = parseFloat(getComputedStyle(chatInput).lineHeight);
	const maxHeight = lineHeight * MAX_LINES;
	const newHeight = Math.min(chatInput.scrollHeight, maxHeight);

	chatInput.style.height = `${newHeight}px`;
	chatInput.style.overflowY = chatInput.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

function updateActionIcon() {
	const hasContent = chatInput.value.trim() !== '' || pendingImages.length > 0;
	actionIcon.innerText = hasContent ? 'send' : 'mic';
}

chatInput.addEventListener('input', () => {
	autoResizeTextarea();
	updateActionIcon();
});

document.getElementById('btnActionChat').addEventListener('click', () => {
	if (recordingState !== 'idle') return; // evita interferência do 'click' pós-toque longo

	if (pendingImages.length > 0) {
		sendPendingImages();
		return;
	}

	const msg = chatInput.value.trim();

	if (msg && dataChannel && dataChannel.readyState === 'open') {
		dataChannel.send(JSON.stringify({ type: 'text', text: msg }));
		printMessage(msg, 'sent');
		chatInput.value = '';
		autoResizeTextarea();
		updateActionIcon();
	}
	// Toque curto com campo vazio: não faz nada (é preciso segurar para gravar)
});

// ==========================================
// 4.15 ENVIO DE IMAGENS
// ==========================================
const MAX_PENDING_IMAGES = 5;
const IMAGE_MAX_DIMENSION = 1280;
const IMAGE_JPEG_QUALITY = 0.82;

let pendingImages = []; // [{ id, dataUrl }]

const imagePreviewTray = document.getElementById('imagePreviewTray');
const inputImagePicker = document.getElementById('inputImagePicker');

document.getElementById('btnSendImage').addEventListener('click', () => {
	inputImagePicker.click();
});

inputImagePicker.addEventListener('change', (e) => {
	handleSelectedFiles(e.target.files);
	e.target.value = ''; // permite selecionar o mesmo arquivo de novo depois
});

// --- Drag & drop (ex: arrastar arquivos do Explorer no Windows) ---
const chatScreenEl = document.getElementById('chatScreen');

['dragenter', 'dragover'].forEach(evt => {
	chatScreenEl.addEventListener(evt, (e) => {
		if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
		e.preventDefault();
		chatScreenEl.classList.add('drag-over');
	});
});

['dragleave', 'drop'].forEach(evt => {
	chatScreenEl.addEventListener(evt, (e) => {
		e.preventDefault();
		chatScreenEl.classList.remove('drag-over');
	});
});

chatScreenEl.addEventListener('drop', (e) => {
	if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
		handleSelectedFiles(e.dataTransfer.files);
	}
});

async function handleSelectedFiles(fileList) {
	const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
	const availableSlots = MAX_PENDING_IMAGES - pendingImages.length;
	if (availableSlots <= 0) return;

	const filesToAdd = files.slice(0, availableSlots);

	for (const file of filesToAdd) {
		try {
			const dataUrl = await resizeImageFile(file, IMAGE_MAX_DIMENSION, IMAGE_JPEG_QUALITY);
			pendingImages.push({
				id: `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				dataUrl
			});
		} catch (err) {
			console.error('Erro ao processar imagem:', err);
		}
	}

	renderImagePreviewTray();
	updateActionIcon();
}

function resizeImageFile(file, maxDimension, quality) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = (e) => {
			const img = new Image();
			img.onload = () => {
				let { width, height } = img;
				if (width > maxDimension || height > maxDimension) {
					if (width > height) {
						height = Math.round(height * (maxDimension / width));
						width = maxDimension;
					} else {
						width = Math.round(width * (maxDimension / height));
						height = maxDimension;
					}
				}
				const canvas = document.createElement('canvas');
				canvas.width = width;
				canvas.height = height;
				canvas.getContext('2d').drawImage(img, 0, 0, width, height);
				resolve(canvas.toDataURL('image/jpeg', quality));
			};
			img.onerror = reject;
			img.src = e.target.result;
		};
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
}

function renderImagePreviewTray() {
	imagePreviewTray.innerHTML = '';

	if (pendingImages.length === 0) {
		imagePreviewTray.style.display = 'none';
		return;
	}

	imagePreviewTray.style.display = 'flex';

	pendingImages.forEach(item => {
		const card = document.createElement('div');
		card.className = 'image-preview-card';

		const img = document.createElement('img');
		img.src = item.dataUrl;
		card.appendChild(img);

		const removeBtn = document.createElement('button');
		removeBtn.type = 'button';
		removeBtn.className = 'image-preview-remove';
		removeBtn.textContent = '×';
		removeBtn.addEventListener('click', () => {
			pendingImages = pendingImages.filter(i => i.id !== item.id);
			renderImagePreviewTray();
			updateActionIcon();
		});
		card.appendChild(removeBtn);

		imagePreviewTray.appendChild(card);
	});
}

function sendPendingImages() {
	const caption = chatInput.value.trim();
	const imagesToSend = pendingImages;

	pendingImages = [];
	chatInput.value = '';
	autoResizeTextarea();
	renderImagePreviewTray();
	updateActionIcon();

	imagesToSend.forEach((item, index) => {
		// O comentário pertence só à última imagem do lote
		const itemCaption = index === imagesToSend.length - 1 ? caption : '';
		printImageMessage(item.dataUrl, itemCaption, 'sent');
		sendImageOverDataChannel(item.dataUrl, itemCaption, 'image/jpeg');
	});
}

// ==========================================
// 4.2 GRAVAÇÃO DE ÁUDIO
// ==========================================
const normalFooterControls = document.getElementById('normalFooterControls');
const recordingFooterControls = document.getElementById('recordingFooterControls');
const recordingRow1 = document.querySelector('.recording-row1');
const recTimerEl = document.getElementById('recTimer');
const recWaveformEl = document.getElementById('recWaveform');
const btnRecPlayPause = document.getElementById('btnRecPlayPause');
const btnRecCancel = document.getElementById('btnRecCancel');
const btnRecToggle = document.getElementById('btnRecToggle');
const btnRecSend = document.getElementById('btnRecSend');

const HOLD_THRESHOLD_MS = 350;
const MAX_RECORDING_MS = 20000;
const WAVE_BAR_COUNT = 28; // usado só na waveform da bolha de mensagem já enviada
const REC_WAVE_BAR_WIDTH = 3; // precisa bater com .wave-bar { width: 3px } no CSS
const REC_WAVE_BAR_GAP = 2;   // precisa bater com o gap de .rec-waveform no CSS

let holdTimer = null;
let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let recordingState = 'idle'; // 'idle' | 'recording' | 'paused'
let recordingElapsedMs = 0;
let recordingSegmentStart = 0;
let recordingTimerInterval = null;
let audioCtx = null;
let analyserNode = null;
let waveformRAF = null;
let previewAudioEl = null;
let totalWaveBars = 0;
let waveBarsAdded = 0;
let peakSinceLastBar = 0;

// --- Início por toque longo ---
document.getElementById('btnActionChat').addEventListener('pointerdown', () => {
	if (chatInput.value.trim() !== '') return; // só grava quando o ícone é o de mic
	holdTimer = setTimeout(startRecording, HOLD_THRESHOLD_MS);
});

['pointerup', 'pointerleave', 'pointercancel'].forEach(evt => {
	document.getElementById('btnActionChat').addEventListener(evt, () => {
		clearTimeout(holdTimer);
	});
});

async function startRecording() {
	try {
		mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
	} catch (err) {
		console.error('Não foi possível acessar o microfone:', err);
		alert('Não foi possível acessar o microfone. Verifique as permissões.');
		return;
	}

	audioChunks = [];
	recordingElapsedMs = 0;
	recordingSegmentStart = performance.now();
	recordingState = 'recording';

	mediaRecorder = new MediaRecorder(mediaStream);
	mediaRecorder.ondataavailable = (e) => {
		if (e.data && e.data.size > 0) audioChunks.push(e.data);
	};
	// Timeslice de 250ms: garante que audioChunks vá sendo preenchido
	// continuamente (não só no .stop()), permitindo o preview durante a pausa.
	mediaRecorder.start(250);

	showRecordingUI(); // precisa ficar visível ANTES de medir a largura da faixa
	initWaveformTrack();
	setupWaveformAnalyser(mediaStream);
	startRecordingTimer();
}

function startRecordingTimer() {
	clearInterval(recordingTimerInterval);
	recordingTimerInterval = setInterval(() => {
		if (recordingState !== 'recording') return; // não mexe no visor durante pausa/prévia

		const now = performance.now();
		recordingElapsedMs += now - recordingSegmentStart;
		recordingSegmentStart = now;

		if (recordingElapsedMs >= MAX_RECORDING_MS) {
			recordingElapsedMs = MAX_RECORDING_MS;
			pauseRecording(); // atinge o limite de 20s: pausa pronta pra enviar
		}

		updateWaveformBars();
		updateRecTimerDisplay();
	}, 100);
}

function updateRecTimerDisplay() {
	recTimerEl.textContent = `${Math.floor(recordingElapsedMs / 1000)}"`;
}

function pauseRecording() {
	if (recordingState !== 'recording') return;
	// Força o flush do que já foi gravado até agora, senão o preview fica vazio.
	if (mediaRecorder.state === 'recording') mediaRecorder.requestData();
	mediaRecorder.pause();
	recordingState = 'paused';
	stopWaveformAnalyser();
	updateRecTimerDisplay(); // fixa o visor no tempo gravado (o setInterval para de mexer nele agora)
	updateRecordingUIState();
}

function resumeRecording() {
	if (recordingState !== 'paused') return;
	if (recordingElapsedMs >= MAX_RECORDING_MS) return; // já no limite de 20s
	discardPreviewAudio();
	mediaRecorder.resume();
	recordingState = 'recording';
	recordingSegmentStart = performance.now();
	setupWaveformAnalyser(mediaStream);
	updateRecordingUIState();
}

btnRecToggle.addEventListener('click', () => {
	if (recordingState === 'recording') pauseRecording();
	else if (recordingState === 'paused') resumeRecording();
});

function updateRecordingUIState() {
	const isPaused = recordingState === 'paused';
	recordingRow1.classList.toggle('state-paused', isPaused);
	btnRecPlayPause.style.display = isPaused ? 'inline-flex' : 'none';
	btnRecToggle.textContent = isPaused ? 'Continuar gravação' : 'Pausar gravação';
	if (isPaused) setPreviewIcon('play_arrow');
}

// --- Preview do que já foi gravado (só disponível pausado) ---
let previewAudioUrl = null;

btnRecPlayPause.addEventListener('click', () => {
	if (recordingState !== 'paused') return;

	if (previewAudioEl) {
		if (previewAudioEl.paused) {
			previewAudioEl.play();
			setPreviewIcon('pause');
		} else {
			previewAudioEl.pause();
			setPreviewIcon('play_arrow');
		}
		return;
	}

	const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
	previewAudioUrl = URL.createObjectURL(blob);
	previewAudioEl = new Audio(previewAudioUrl);

	previewAudioEl.addEventListener('timeupdate', updatePreviewProgress);
	previewAudioEl.addEventListener('ended', () => {
		setPreviewIcon('play_arrow');
		resetPreviewProgress();
	});

	previewAudioEl.play();
	setPreviewIcon('pause');
});

function updatePreviewProgress() {
	if (!previewAudioEl) return;

	// Usa o tempo que NÓS cronometramos, não audioEl.duration — blobs do
	// MediaRecorder retornam duration = Infinity em vários navegadores.
	const durationSec = recordingElapsedMs / 1000;
	if (durationSec <= 0) return;

	// Mesma lógica de "tocado/não tocado" usada na bolha de mensagem de áudio
	const bars = recWaveformEl.querySelectorAll('.wave-bar');
	if (bars.length) {
		const progress = Math.min(1, previewAudioEl.currentTime / durationSec);
		const playedCount = Math.floor(progress * bars.length);
		bars.forEach((bar, i) => bar.classList.toggle('played', i < playedCount));
	}

	const remaining = Math.max(0, Math.ceil(durationSec - previewAudioEl.currentTime));
	recTimerEl.textContent = `${remaining}"`;
}

function resetPreviewProgress() {
	recWaveformEl.querySelectorAll('.wave-bar').forEach(bar => bar.classList.remove('played'));
	updateRecTimerDisplay(); // volta a mostrar o tempo gravado (não mais o de reprodução)
}

function discardPreviewAudio() {
	if (previewAudioEl) {
		previewAudioEl.pause();
		previewAudioEl.removeEventListener('timeupdate', updatePreviewProgress);
	}
	if (previewAudioUrl) {
		URL.revokeObjectURL(previewAudioUrl);
		previewAudioUrl = null;
	}
	previewAudioEl = null;
	resetPreviewProgress();
}

function setPreviewIcon(iconName) {
	const icon = btnRecPlayPause.querySelector('md-icon');
	if (icon) icon.textContent = iconName;
}

// --- Cancelar ---
btnRecCancel.addEventListener('click', cancelRecording);

function cancelRecording() {
	if (mediaRecorder && mediaRecorder.state !== 'inactive') {
		mediaRecorder.onstop = null;
		mediaRecorder.stop();
	}
	if (previewAudioEl) { discardPreviewAudio(); }
	stopMediaStream();
	stopWaveformAnalyser();
	clearInterval(recordingTimerInterval);
	audioChunks = [];
	recordingState = 'idle';
	hideRecordingUI();
}

function stopMediaStream() {
	if (mediaStream) {
		mediaStream.getTracks().forEach(track => track.stop());
		mediaStream = null;
	}
}

// --- Enviar ---
btnRecSend.addEventListener('click', finishAndSendRecording);

function finishAndSendRecording() {
	if (!mediaRecorder) return;
	if (previewAudioEl) { discardPreviewAudio(); }

	const durationSeconds = Math.max(1, Math.round(recordingElapsedMs / 1000));

	if (mediaRecorder.state === 'inactive') {
		sendRecordedAudio(durationSeconds);
	} else {
		mediaRecorder.onstop = () => sendRecordedAudio(durationSeconds);
		mediaRecorder.stop();
	}
}

async function sendRecordedAudio(durationSeconds) {
	stopWaveformAnalyser();
	clearInterval(recordingTimerInterval);
	stopMediaStream();

	const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
	audioChunks = [];
	recordingState = 'idle';
	hideRecordingUI();

	const peaks = await computeWaveformPeaks(blob, WAVE_BAR_COUNT);
	const localUrl = URL.createObjectURL(blob);

	printAudioMessage({ url: localUrl, duration: durationSeconds, peaks }, 'sent');
	sendAudioOverDataChannel(blob, durationSeconds, peaks);
}

// --- Troca de UI do footer ---
function showRecordingUI() {
	normalFooterControls.style.display = 'none';
	recordingFooterControls.style.display = 'flex';
	updateRecordingUIState();
	updateRecTimerDisplay();
}

function hideRecordingUI() {
	recordingFooterControls.style.display = 'none';
	normalFooterControls.style.display = 'flex';
	recordingRow1.classList.remove('state-paused');
	resetWaveformTrack();
}

// --- Waveform (faixa que cresce de 0 até a largura máxima, em 20s) ---
function initWaveformTrack() {
	recWaveformEl.innerHTML = '';
	const availableWidth = recWaveformEl.clientWidth; // maior largura possível, já respeitando o gap pros outros elementos
	const slot = REC_WAVE_BAR_WIDTH + REC_WAVE_BAR_GAP;
	totalWaveBars = Math.max(1, Math.floor(availableWidth / slot));
	waveBarsAdded = 0;
	peakSinceLastBar = 0;
}

function updateWaveformBars() {
	if (totalWaveBars === 0) return;
	const barIntervalMs = MAX_RECORDING_MS / totalWaveBars;
	const shouldHave = Math.min(totalWaveBars, Math.floor(recordingElapsedMs / barIntervalMs));

	while (waveBarsAdded < shouldHave) {
		appendWaveBar(peakSinceLastBar);
		peakSinceLastBar = 0;
		waveBarsAdded++;
	}
}

function appendWaveBar(level) {
	const bar = document.createElement('div');
	bar.className = 'wave-bar';
	const minH = 4, maxH = 26;
	bar.style.height = `${minH + Math.min(1, level) * (maxH - minH)}px`;
	recWaveformEl.appendChild(bar);
}

function resetWaveformTrack() {
	recWaveformEl.innerHTML = '';
	totalWaveBars = 0;
	waveBarsAdded = 0;
	peakSinceLastBar = 0;
}

function setupWaveformAnalyser(stream) {
	if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
	const source = audioCtx.createMediaStreamSource(stream);
	analyserNode = audioCtx.createAnalyser();
	analyserNode.fftSize = 256;
	source.connect(analyserNode);

	const dataArray = new Uint8Array(analyserNode.frequencyBinCount);

	function tick() {
		analyserNode.getByteTimeDomainData(dataArray);
		let sum = 0;
		for (let i = 0; i < dataArray.length; i++) {
			const v = (dataArray[i] - 128) / 128;
			sum += v * v;
		}
		const rms = Math.sqrt(sum / dataArray.length);
		peakSinceLastBar = Math.max(peakSinceLastBar, Math.min(1, rms * 4));
		waveformRAF = requestAnimationFrame(tick);
	}
	tick();
}

function stopWaveformAnalyser() {
	if (waveformRAF) cancelAnimationFrame(waveformRAF);
	waveformRAF = null;
}

async function computeWaveformPeaks(blob, barCount) {
	try {
		const arrayBuffer = await blob.arrayBuffer();
		if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
		const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
		const channelData = audioBuffer.getChannelData(0);
		const blockSize = Math.max(1, Math.floor(channelData.length / barCount));
		const peaks = [];

		for (let i = 0; i < barCount; i++) {
			let max = 0;
			const start = i * blockSize;
			for (let j = 0; j < blockSize; j++) {
				const v = Math.abs(channelData[start + j] || 0);
				if (v > max) max = v;
			}
			peaks.push(max);
		}

		const globalMax = Math.max(...peaks, 0.05);
		return peaks.map(p => p / globalMax);
	} catch (err) {
		console.error('Erro ao gerar waveform:', err);
		return new Array(barCount).fill(0.4);
	}
}

// --- Renderização da bolha de mensagem de áudio ---
function printAudioMessage({ url, duration, peaks }, type) {
	const area = document.getElementById('chatMessagesArea');
	const bubble = document.createElement('div');
	bubble.className = `message-bubble audio-bubble ${type}`;

	const audioEl = new Audio(url);

	const playBtn = document.createElement('button');
	playBtn.className = 'audio-play-btn';
	playBtn.innerHTML = '<md-icon>play_arrow</md-icon>';

	const timer = document.createElement('span');
	timer.className = 'audio-timer';
	timer.textContent = `${duration}"`;

	const waveform = document.createElement('div');
	waveform.className = 'audio-waveform';
	peaks.forEach(p => {
		const bar = document.createElement('div');
		bar.className = 'wave-bar unplayed';
		bar.style.height = `${4 + p * 22}px`;
		waveform.appendChild(bar);
	});

	const restartBtn = document.createElement('button');
	restartBtn.className = 'audio-restart-btn';
	restartBtn.innerHTML = '<md-icon>skip_previous</md-icon>';

	bubble.append(playBtn, timer, waveform, restartBtn);
	area.appendChild(bubble);
	area.scrollTop = area.scrollHeight;

	playBtn.addEventListener('click', () => {
		if (audioEl.paused) audioEl.play();
		else audioEl.pause();
	});

	restartBtn.addEventListener('click', () => {
		audioEl.currentTime = 0;
		audioEl.play();
	});

	audioEl.addEventListener('play', () => {
		playBtn.querySelector('md-icon').textContent = 'pause';
	});

	audioEl.addEventListener('pause', () => {
		playBtn.querySelector('md-icon').textContent = 'play_arrow';
	});

	audioEl.addEventListener('ended', () => {
		playBtn.querySelector('md-icon').textContent = 'play_arrow';
		timer.textContent = `${duration}"`;
		waveform.querySelectorAll('.wave-bar').forEach(bar => bar.classList.remove('played'));
	});

	audioEl.addEventListener('timeupdate', () => {
		// Usa a 'duration' que veio com a mensagem, não audioEl.duration
		// (blobs do MediaRecorder retornam Infinity em vários navegadores).
		if (!duration) return;
		const remaining = Math.max(0, Math.ceil(duration - audioEl.currentTime));
		timer.textContent = `${remaining}"`;

		const progress = Math.min(1, audioEl.currentTime / duration);
		const bars = waveform.querySelectorAll('.wave-bar');
		const playedCount = Math.floor(progress * bars.length);
		bars.forEach((bar, i) => bar.classList.toggle('played', i < playedCount));
	});
}

// --- Renderização da bolha de mensagem de imagem ---
function printImageMessage(dataUrl, caption, type) {
	const area = document.getElementById('chatMessagesArea');
	const bubble = document.createElement('div');
	bubble.className = `message-bubble image-bubble ${type}`;

	const photoWrap = document.createElement('div');
	photoWrap.className = 'image-bubble-photo';

	const img = document.createElement('img');
	img.src = dataUrl;
	img.loading = 'lazy';
	img.alt = 'Imagem enviada';
	photoWrap.appendChild(img);

	photoWrap.addEventListener('click', () => openImageLightbox(dataUrl));
	bubble.appendChild(photoWrap);

	if (caption) {
		const captionEl = document.createElement('p');
		captionEl.className = 'image-bubble-caption';
		captionEl.innerHTML = parseSimpleMarkdown(caption);
		bubble.appendChild(captionEl);
	}

	area.appendChild(bubble);
	area.scrollTop = area.scrollHeight;
}

// ==========================================
// 4.3 LIGHTBOX DE IMAGEM (POP-UP EM TELA CHEIA)
// ==========================================
const imageLightboxEl = document.getElementById('imageLightbox');
const lightboxImageEl = document.getElementById('lightboxImage');
const lightboxImageAreaEl = document.getElementById('lightboxImageArea');

const LIGHTBOX_MIN_ZOOM = 1;
const LIGHTBOX_MAX_ZOOM = 4;
const LIGHTBOX_ZOOM_STEP = 0.5;

let currentLightboxDataUrl = null;
let lightboxZoom = 1;
let lightboxPanX = 0;
let lightboxPanY = 0;
let isDraggingLightbox = false;
let lightboxDragStartX = 0;
let lightboxDragStartY = 0;
let lightboxPanStartX = 0;
let lightboxPanStartY = 0;

function openImageLightbox(dataUrl) {
	currentLightboxDataUrl = dataUrl;
	lightboxImageEl.src = dataUrl;
	lightboxZoom = 1;
	lightboxPanX = 0;
	lightboxPanY = 0;
	applyLightboxTransform();
	imageLightboxEl.style.display = 'flex';
}

function closeImageLightbox() {
	imageLightboxEl.style.display = 'none';
	lightboxImageEl.src = '';
	currentLightboxDataUrl = null;
}

function setLightboxZoom(zoom) {
	lightboxZoom = Math.min(LIGHTBOX_MAX_ZOOM, Math.max(LIGHTBOX_MIN_ZOOM, zoom));
	if (lightboxZoom === LIGHTBOX_MIN_ZOOM) {
		lightboxPanX = 0;
		lightboxPanY = 0;
	}
	applyLightboxTransform();
}

function applyLightboxTransform() {
	lightboxImageEl.style.transform = `translate(${lightboxPanX}px, ${lightboxPanY}px) scale(${lightboxZoom})`;
}

document.getElementById('btnLightboxClose').addEventListener('click', closeImageLightbox);
document.getElementById('btnLightboxZoomIn').addEventListener('click', () => setLightboxZoom(lightboxZoom + LIGHTBOX_ZOOM_STEP));
document.getElementById('btnLightboxZoomOut').addEventListener('click', () => setLightboxZoom(lightboxZoom - LIGHTBOX_ZOOM_STEP));

// --- Arrastar pra mover a imagem (zoom só pelos botões, sem gesto de pinça) ---
lightboxImageAreaEl.addEventListener('pointerdown', (e) => {
	isDraggingLightbox = true;
	lightboxDragStartX = e.clientX;
	lightboxDragStartY = e.clientY;
	lightboxPanStartX = lightboxPanX;
	lightboxPanStartY = lightboxPanY;
	lightboxImageAreaEl.setPointerCapture(e.pointerId);
});

lightboxImageAreaEl.addEventListener('pointermove', (e) => {
	if (!isDraggingLightbox) return;
	lightboxPanX = lightboxPanStartX + (e.clientX - lightboxDragStartX);
	lightboxPanY = lightboxPanStartY + (e.clientY - lightboxDragStartY);
	applyLightboxTransform();
});

['pointerup', 'pointercancel'].forEach(evt => {
	lightboxImageAreaEl.addEventListener(evt, () => { isDraggingLightbox = false; });
});

// --- Compartilhar ---
document.getElementById('btnLightboxShare').addEventListener('click', async () => {
	if (!currentLightboxDataUrl) return;
	try {
		const blob = await (await fetch(currentLightboxDataUrl)).blob();
		const file = new File([blob], 'anonimus-imagem.jpg', { type: blob.type });

		if (navigator.canShare && navigator.canShare({ files: [file] })) {
			await navigator.share({ files: [file] });
		} else if (navigator.share) {
			await navigator.share({ url: currentLightboxDataUrl });
		} else {
			alert('Compartilhamento não é suportado neste navegador.');
		}
	} catch (err) {
		if (err.name !== 'AbortError') console.error('Erro ao compartilhar imagem:', err);
	}
});

// --- Copiar ---
document.getElementById('btnLightboxCopy').addEventListener('click', async () => {
	if (!currentLightboxDataUrl) return;
	try {
		const pngBlob = await dataUrlToPngBlob(currentLightboxDataUrl);
		await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
	} catch (err) {
		console.error('Erro ao copiar imagem:', err);
		alert('Não foi possível copiar a imagem neste navegador.');
	}
});

function dataUrlToPngBlob(dataUrl) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement('canvas');
			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;
			canvas.getContext('2d').drawImage(img, 0, 0);
			canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Falha ao converter imagem')), 'image/png');
		};
		img.onerror = reject;
		img.src = dataUrl;
	});
}

// --- Baixar ---
document.getElementById('btnLightboxDownload').addEventListener('click', () => {
	if (!currentLightboxDataUrl) return;
	const a = document.createElement('a');
	a.href = currentLightboxDataUrl;
	a.download = `anonimus_${Date.now()}.jpg`;
	document.body.appendChild(a);
	a.click();
	a.remove();
});

// ==========================================
// 5. INTERFACE (UI)
// ==========================================
function setGenderIcon(gender) {
	const genderIcon = document.getElementById('chatTargetGenderIcon');
	if (!genderIcon) return;

	genderIcon.classList.remove('gender-male', 'gender-female', 'gender-unknown');

	if (gender === 'masculino') {
		genderIcon.innerText = 'male';
		genderIcon.classList.add('gender-male');
		genderIcon.style.display = 'inline-block';
	} else if (gender === 'feminino') {
		genderIcon.innerText = 'female';
		genderIcon.classList.add('gender-female');
		genderIcon.style.display = 'inline-block';
	} else {
		genderIcon.innerText = 'question_mark';
		genderIcon.classList.add('gender-unknown');
		genderIcon.style.display = 'inline-block';
	}
}

function hideGenderIcon() {
	const genderIcon = document.getElementById('chatTargetGenderIcon');
	if (genderIcon) genderIcon.style.display = 'none';
}

function setStatus(statusText, icon = 'person_search') {
	document.getElementById('chatTargetName').innerText = statusText;
	document.getElementById('chatTargetAvatar').style.display = 'none';
	const fallbackIcon = document.getElementById('chatTargetIconFallback');
	fallbackIcon.style.display = 'flex';
	fallbackIcon.querySelector('span').innerText = icon;
	hideGenderIcon();
}

function setDisconnectedUI(statusText) {
	const headerInfo = document.querySelector('.chat-header-info');
	headerInfo.classList.remove('is-searching');
	setStatus(statusText, 'person_cancel');
}

function setPartnerName(name) {
	document.getElementById('chatTargetName').innerText = name;
}

function setSearchingUI() {
	const headerInfo = document.querySelector('.chat-header-info');
	headerInfo.classList.add('is-searching'); // Liga as animações CSS
	
	document.getElementById('chatTargetName').innerText = "Procurando alguém...";
	document.getElementById('chatTargetAvatar').style.display = 'none';
	
	const fallbackIcon = document.getElementById('chatTargetIconFallback');
	fallbackIcon.style.display = 'flex'; // ou 'block', dependendo do seu CSS base
	fallbackIcon.querySelector('span').innerText = 'person_search';

	hideGenderIcon();
}

function setPartnerUI(partnerInfo) {
	const headerInfo = document.querySelector('.chat-header-info');
	headerInfo.classList.remove('is-searching'); // Desliga as animações imediatamente
	
	document.getElementById('chatTargetName').innerText = partnerInfo.name || "Anônimo";
	setGenderIcon(partnerInfo.gender);
	
	const fallbackIcon = document.getElementById('chatTargetIconFallback');
	
	if (partnerInfo.avatar && partnerInfo.avatar.startsWith('data:image')) {
		const avatarImg = document.getElementById('chatTargetAvatar');
		avatarImg.src = partnerInfo.avatar;
		avatarImg.style.display = 'block';
		fallbackIcon.style.display = 'none';
	} else {
		document.getElementById('chatTargetAvatar').style.display = 'none';
		fallbackIcon.style.display = 'flex';
		fallbackIcon.querySelector('span').innerText = 'person'; // Tira a lupa e bota o boneco
	}
}


function parseSimpleMarkdown(rawText) {
	// 1. Escapa HTML para evitar injeção de código pelo parceiro remoto
	let text = rawText
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');

	// 2. Código: protege o conteúdo antes de aplicar as outras formatações
	const codeBlocks = [];
	text = text.replace(/`(.+?)`/g, (match, content) => {
		codeBlocks.push(content);
		return `\u0000${codeBlocks.length - 1}\u0000`;
	});

	// 3. Sublinhado (__texto__) — antes do itálico para não conflitar
	text = text.replace(/__(.+?)__/g, '<u>$1</u>');

	// 4. Negrito (*texto*)
	text = text.replace(/\*(.+?)\*/g, '<strong>$1</strong>');

	// 5. Itálico (_texto_)
	text = text.replace(/_(.+?)_/g, '<em>$1</em>');

	// 6. Riscado (~texto~)
	text = text.replace(/~(.+?)~/g, '<s>$1</s>');

	// 7. Restaura os blocos de código
	text = text.replace(/\u0000(\d+)\u0000/g, (match, index) => `<code>${codeBlocks[Number(index)]}</code>`);

	// 8. Preserva quebras de linha
	return text.replace(/\n/g, '<br>');
}

function printMessage(text, type) {
	const area = document.getElementById('chatMessagesArea');
	const bubble = document.createElement('div');
	bubble.className = `message-bubble ${type}`;
	bubble.innerHTML = `<p>${parseSimpleMarkdown(text)}</p>`;
	area.appendChild(bubble);
	area.scrollTop = area.scrollHeight;
}

function skipPartner() {
	if (peerConnection) {
		peerConnection.close();
		peerConnection = null;
	}
	
	if (currentRoomId) {
		remove(ref(db, `rooms/${currentRoomId}`));
		currentRoomId = null;
	}
	
	partnerData = null;
	document.getElementById('chatMessagesArea').innerHTML = ''; 
	setSearchingUI(); 
	findMatch(); 
}

document.addEventListener('DOMContentLoaded', findMatch);
document.getElementById('btnSkip').addEventListener('click', skipPartner);
