document.addEventListener('DOMContentLoaded', () => {
	const btnProfilePic = document.getElementById('btn-profile-pic');
	const inputProfilePic = document.getElementById('input-profile-pic');
	const cropperDialog = document.getElementById('cropper-dialog');
	const imageToCrop = document.getElementById('image-to-crop');
	const btnCancelCrop = document.getElementById('btn-cancel-crop');
	const btnConfirmCrop = document.getElementById('btn-confirm-crop');
	
	const btnTextChat = document.getElementById('btn-text-chat');
	const checkTerms = document.getElementById('terms-checkbox');
	
	if (btnTextChat) {
		btnTextChat.addEventListener('click', (e) => {
			e.preventDefault();

			if (checkTerms && !checkTerms.checked) {
				alert("Você precisa aceitar os termos de uso para continuar.");
				return;
			}

			// Busca flexível do campo de apelido/nome
			const inputName = document.getElementById('input-nickname') || 
							  document.getElementById('nickname') || 
							  document.querySelector('md-outlined-text-field') ||
							  document.querySelector('input[type="text"]');

			const rawName = inputName ? inputName.value.trim() : '';
			const myName = rawName !== '' ? rawName : 'Anônimo';
			const myAvatar = localStorage.getItem('anonimus_profile_pic') || '';

			const selectGender = document.getElementById('select-gender');
			const myGender = selectGender ? selectGender.value : 'neutro';

			const selectInterest = document.getElementById('select-interest');
			const myInterest = selectInterest ? selectInterest.value : 'neutro';

			// Salva os dados na sessão
			sessionStorage.setItem('anonimus_my_data', JSON.stringify({
				name: myName,
				avatar: myAvatar,
				gender: myGender,
				interest: myInterest
			}));

			window.location.href = 'chat.html';
		});
	}

	// 1. Carrega foto de perfil caso exista no LocalStorage ao iniciar o App
	const savedPic = localStorage.getItem('anonimus_profile_pic');
	if (savedPic) {
		setProfilePic(savedPic);
	}

	// 2. Quando clicar no botão circular, aciona o input invisível
	btnProfilePic.addEventListener('click', () => {
		inputProfilePic.click();
	});

	// 3. Quando o usuário seleciona uma imagem da galeria
	inputProfilePic.addEventListener('change', (event) => {
		const file = event.target.files[0];
		if (file) {
			const reader = new FileReader();
			reader.onload = (e) => {
				// Joga a imagem selecionada na tag <img> dentro do Modal
				imageToCrop.src = e.target.result;
				
				// Mostra o Modal (Dialog) - Sem delay, a inicialização ocorre no evento 'opened' abaixo
				cropperDialog.show();
			};
			reader.readAsDataURL(file);
		}
	});

	// 4. Cancelar o corte
	btnCancelCrop.addEventListener('click', () => {
		cropperDialog.close();
		inputProfilePic.value = ''; // Reseta o input para permitir selecionar a mesma foto novamente
		if (window.cropper) {
			window.cropper.destroy();
			window.cropper = null;
		}
	});

	// 5. Confirmar o corte (Salvar)
	btnConfirmCrop.addEventListener('click', () => {
		if (!window.cropper) return;

		// Extrai a imagem cortada como Canvas num formato 300x300px (1:1)
		const canvas = window.cropper.getCroppedCanvas({
			width: 300,
			height: 300,
		});

		// Converte a imagem para Base64 (formato JPEG com 80% de qualidade para poupar espaço)
		const base64Image = canvas.toDataURL('image/jpeg', 0.8);

		// Salva localmente no dispositivo do usuário (para persistência no P2P)
		localStorage.setItem('anonimus_profile_pic', base64Image);

		// Atualiza o botão da interface visual instantaneamente
		setProfilePic(base64Image);

		// Fecha o modal e destrói a instância do manipulador
		cropperDialog.close();
		window.cropper.destroy();
		window.cropper = null;
	});

	// Função auxiliar para aplicar a imagem de fundo no botão da tela inicial
	function setProfilePic(base64Image) {
		btnProfilePic.style.backgroundImage = `url(${base64Image})`;
		btnProfilePic.classList.add('has-image'); // Aplica a classe que oculta texto/ícone no CSS
	}

});

// ==========================================
// A Lógica do Bug de Alinhamento (O Pulo do Gato)
// ==========================================
const dialog = document.getElementById('cropper-dialog');
const image = document.getElementById('image-to-crop');
window.cropper = null; // Instância em escopo global para ambas as partes do script

// Escuta o evento nativo do Material Web (M3) de quando a animação do modal realmente acaba
dialog.addEventListener('opened', () => {
	// Destrói a instância velha se houver um comportamento anômalo
	if (window.cropper) {
		window.cropper.destroy();
	}
	
	// Agora sim o elemento tem largura/altura e o Cropper consegue calcular perfeitamente
	window.cropper = new Cropper(image, {
		aspectRatio: 1, // Força corte quadrado para botões circulares
		viewMode: 1, // Restringe a caixa de corte dentro do canvas
		dragMode: 'move', // Ideal para toque mobile em substituição ao cursor
		autoCropArea: 1,
		restore: false,
		guides: false,
		center: false,
		highlight: false,
		cropBoxMovable: false,
		cropBoxResizable: false,
		toggleDragModeOnDblclick: false,
	});
});
