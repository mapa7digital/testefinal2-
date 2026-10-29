import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ==========================================================================
// Visualizador 3D + Realidade Aumentada para o modelo capybara_low_poly.glb
//
// A RA agora usa MindAR (rastreamento de IMAGEM, via câmera). A capivara aparece
// em cima da maquete (foto de referência: alvo.jpg). O arquivo targets.mind é a versão "compilada" dessa imagem —
// se trocar a imagem, gere outro .mind em
// https://hiukim.github.io/mind-ar-js-doc/tools/compile
//
// A animação de entrada (deslizamento) do modelo "de mesa" foi retirada
// daqui e vive em ./modules/entranceAnimation.js — veja aquele arquivo se
// quiser reativá-la.
// ==========================================================================

// Alvo da RA: a MAQUETE física. alvo.jpg é a foto frontal dela (recortada) e
// targets.mind é essa foto compilada para o MindAR.
// Modelo 3D exibido (GLB: já traz geometria, materiais e texturas embutidos)
const MODEL_URL = './capybara_low_poly.glb';

const AR_TARGET_IMAGE_URL = './alvo.jpg';
const AR_TARGET_MIND_URL = './targets.mind';
// Tamanho da capivara na RA em relação à LARGURA da maquete (1 = mesma largura; 0.4 = 40%)
const AR_MODEL_SCALE = 0.4;

// ---------- Suavização do rastreamento (anti-tremor) ----------
// O rastreamento de imagem entrega a posição da câmera em "degraus" e com
// ruído. Em vez de colar a capivara direto nesses valores, ela segue a
// imagem por uma suavização exponencial, independente da taxa de quadros.
//   AR_SMOOTHING: maior = segue mais rápido (mais tremor); menor = mais macio (mais atraso).
//   Faixa útil: 4 (bem macio) a 15 (bem ágil).
const AR_SMOOTHING = 7;
// Filtro interno do MindAR (One Euro). Valores menores de FILTER_MIN_CF e
// FILTER_BETA reduzem o tremor, ao custo de um pequeno atraso ao mover.
const AR_FILTER_MIN_CF = 0.0001;
const AR_FILTER_BETA = 20;
// Quantos quadros sem ver a imagem antes de esconder o modelo (evita piscar)
const AR_MISS_TOLERANCE = 10;
const AR_WARMUP_TOLERANCE = 8;

// ---------- Desempenho: ajustes gerais ----------
// Limita a densidade de pixels: em telas 3x, renderizar a 3x é pesado e quase
// não melhora a imagem de um modelo 3D.
const MAX_PIXEL_RATIO = 2;
const AR_PIXEL_RATIO = 1.5;
// Texturas maiores que isso (em pixels) são reduzidas na carga: menos memória
// de GPU e menos travada no primeiro desenho.
const MAX_TEXTURE_SIZE = 1024;

// A biblioteca do MindAR (com TensorFlow.js) é grande. Em vez de carregá-la
// junto com a página, ela é importada só quando precisa — e pré-carregada em
// segundo plano quando o navegador está ocioso, para o botão responder rápido.
let mindarModulePromise = null;
function loadMindAR() {
    if (!mindarModulePromise) {
        mindarModulePromise = import('mindar-image-three').catch((err) => {
            mindarModulePromise = null; // permite tentar de novo
            throw err;
        });
    }
    return mindarModulePromise;
}

function whenIdle(fn) {
    if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout: 4000 });
    else setTimeout(fn, 1500);
}

function reportFatal(msg) {
    console.error(msg);
    const box = document.getElementById('ar-warning');
    if (box) { box.style.display = 'block'; box.textContent = msg; }
}
window.addEventListener('unhandledrejection', (e) => reportFatal('Erro: ' + describeError(e.reason)));

const infoEl = document.getElementById('info');
const loadingEl = document.getElementById('loading');
const arContainer = document.getElementById('ar-button-container');
const arWarning = document.getElementById('ar-warning');

const DEFAULT_INFO_TEXT = 'Capivara 3D — arraste para girar, scroll para zoom';
const AR_INFO_TEXT = 'Aponte a câmera para a maquete para ver a capivara sobre ela.';

// ==========================================================================
// ---------- MOVIMENTO: rotação automática e eixo vertical do modelo ----------
// Toda a lógica de "movimento" do modelo fica concentrada aqui, separada do
// resto do arquivo, para ficar fácil de achar e ajustar.
// ==========================================================================

// Rotação automática (gira sozinha, além do arraste manual do OrbitControls
// no modo "de mesa"). Isso é aplicado tanto no modelo "de mesa" quanto no
// modelo da RA, no loop de animação lá embaixo.
const MODEL_AUTO_ROTATE = true;      // true = a capivara gira sozinho; false = fica parado até o usuário arrastar
const MODEL_ROTATION_SPEED = 0.6;    // radianos por segundo (≈ 34°/s) — velocidade da rotação automática
const MODEL_ROTATION_AXIS = 'y';     // eixo da rotação automática: 'x', 'y' ou 'z'

// Eixo vertical (Y) do modelo, usado para apoiar a capivara sobre o marcador
// na RA. Alguns modelo são exportados com o eixo Y espelhado/invertido em
// relação ao que o three.js espera (Y crescendo para cima). Se a capivara
// aparecer de cabeça para baixo, flutuando ou afundado no marcador, alterne
// este valor — é usado lá em setupARScene().
const INVERT_MODEL_Y = false;

// Relógio para calcular a rotação automática em radianos/segundo "de
// verdade", independente da taxa de quadros (FPS) do dispositivo.
const clock = new THREE.Clock();

// ==========================================================================
// ---------- Modo "de mesa" (visualização normal, fora da RA) ----------
// ==========================================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d0f);

const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.01,
    2000
);
camera.position.set(0, 0, 150);

const renderer = new THREE.WebGLRenderer({
    antialias: window.devicePixelRatio < 2, // em telas densas o antialias quase não se nota e custa caro
    alpha: true,
    powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Controles de mouse/touch (arrastar para girar, scroll para zoom) - só
// fazem sentido no modo "de mesa", fora da sessão de RA.
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Luzes do modo "de mesa"
const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
directionalLight.position.set(1, 1, 1);
scene.add(directionalLight);

const backLight = new THREE.DirectionalLight(0xffffff, 0.4);
backLight.position.set(-1, -1, -1);
scene.add(backLight);

// ---------- Estado do modelo carregado ----------
// modelObject é um "wrapper" (THREE.Group) que contém o objeto do modelo como
// filho. O objeto do modelo é centralizado dentro desse wrapper (equivalente ao
// que era feito com geometry.translate() no STL), enquanto o próprio
// wrapper fica em (0,0,0) — assim dá para reaproveitar o wrapper tanto no
// modo "de mesa" quanto (clonado) na RA, aplicando escala/posição/rotação
// nele sem bagunçar a centralização interna.
let modelObject = null;
let modelSize = null; // THREE.Vector3 com as dimensões do bounding box
let modelMaxDim = 1;
let previewMesh = null; // wrapper do modo "de mesa" (guardado para a rotação automática)

// Material usado como fallback para malhas do modelo que não trouxerem material
// próprio embutido no arquivo.
const FALLBACK_MATERIAL = new THREE.MeshStandardMaterial({
    color: 0xa9835a,
    metalness: 0.05,
    roughness: 0.85
});

// ---------- Otimização do modelo carregado ----------
function downscaleTexture(tex) {
    const img = tex && tex.image;
    if (!img || !img.width || !img.height) return;
    const biggest = Math.max(img.width, img.height);
    if (biggest <= MAX_TEXTURE_SIZE) return;
    const k = MAX_TEXTURE_SIZE / biggest;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k));
    c.height = Math.max(1, Math.round(img.height * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    tex.image = c;
    tex.needsUpdate = true;
}

function optimizeModel(root) {
    const seen = new Set();
    root.traverse((child) => {
        if (child.isMesh) {
            // Sem sombras e sem animação neste visualizador: nada disso é necessário
            child.castShadow = false;
            child.receiveShadow = false;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m) => {
                if (!m || seen.has(m)) return;
                seen.add(m);
                for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'bumpMap']) {
                    if (m[key]) {
                        downscaleTexture(m[key]);
                        m[key].anisotropy = 4;
                    }
                }
            });
            // Calcula uma vez a esfera de corte (evita recalcular depois)
            if (child.geometry && !child.geometry.boundingSphere) child.geometry.computeBoundingSphere();
        }
    });
    // O modelo não tem animação: congela as matrizes dos filhos (o wrapper continua girando)
    root.updateMatrixWorld(true);
    root.traverse((child) => {
        if (child !== root) {
            child.matrixAutoUpdate = false;
        }
    });
}

// Força o upload das texturas para a GPU durante o carregamento
function warmUpTextures(root) {
    root.traverse((child) => {
        if (!child.isMesh) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => {
            if (m && m.map) renderer.initTexture(m.map);
        });
    });
}

// ---------- Carregamento do modelo ----------
const loader = new GLTFLoader();

loader.load(
    MODEL_URL,
    (gltf) => {
        const object = gltf.scene;
        object.traverse((child) => {
            if (child.isMesh && !child.material) {
                child.material = FALLBACK_MATERIAL;
            }
        });
        optimizeModel(object);

        // Centraliza a capivara: mede a caixa delimitadora do objeto recém
        // carregado (ainda na origem) e desloca o próprio objeto para que
        // seu centro fique em (0,0,0).
        const box = new THREE.Box3().setFromObject(object);
        const center = new THREE.Vector3();
        box.getCenter(center);
        object.position.sub(center);

        modelSize = new THREE.Vector3();
        box.getSize(modelSize);
        modelMaxDim = Math.max(modelSize.x, modelSize.y, modelSize.z) || 1;

        // O objeto centralizado vira filho de um wrapper — é esse wrapper
        // que manipulamos (posição/escala/rotação) daqui pra frente.
        modelObject = new THREE.Group();
        modelObject.add(object);

        // Modelo "de mesa" - aparece direto centralizado. A rotação
        // automática (se MODEL_AUTO_ROTATE estiver true) é aplicada no loop
        // de animação lá embaixo; não há mais animação de entrada por
        // deslizamento.
        previewMesh = modelObject;
        camera.position.set(0, 0, modelMaxDim * 2);
        controls.target.set(0, 0, 0);
        controls.update();
        scene.add(previewMesh);

        // Compila shaders e envia geometria/texturas para a GPU AGORA, enquanto
        // ainda mostramos "Carregando", em vez de travar no primeiro frame.
        renderer.compile(scene, camera);
        warmUpTextures(object);

        if (loadingEl) loadingEl.style.display = 'none';
        checkARSupport();

        // Pré-carrega o MindAR e o arquivo do alvo quando o navegador estiver ocioso
        whenIdle(() => {
            loadMindAR().catch(() => {});
            fetch(AR_TARGET_MIND_URL).catch(() => {});
        });
    },
    (xhr) => {
        if (xhr.total && loadingEl) {
            const pct = ((xhr.loaded / xhr.total) * 100).toFixed(0);
            loadingEl.textContent = `Carregando modelo... ${pct}%`;
        } else if (loadingEl) {
            loadingEl.textContent = `Carregando modelo... ${(xhr.loaded / 1048576).toFixed(1)} MB`;
        }
    },
    (error) => {
        console.error('Erro ao carregar o modelo:', error);
        if (loadingEl) {
            loadingEl.textContent = 'Erro ao carregar capybara_low_poly.glb. Verifique se o arquivo está na mesma pasta.';
        }
    }
);

// ==========================================================================
// ---------- Realidade Aumentada (MindAR, rastreamento de imagem) ----------
// ==========================================================================
let arActive = false;
let mindar = null;       // instância do MindARThree
let arAnchor = null;     // âncora presa à imagem-alvo
let arFollow = null;     // grupo que SEGUE a âncora de forma suavizada
let arFollowReady = false; // false até a 1ª leitura da pose (aí ele "pula" direto para a posição)
let arMesh = null;       // wrapper da capivara dentro da RA (guardado para a rotação automática)
let arContainer3D = null; // div onde o MindAR coloca vídeo + canvas

function showWarning(msg) {
    if (!arWarning) return;
    arWarning.style.display = 'block';
    arWarning.textContent = msg;
}

function describeError(e) {
    if (!e) return 'erro desconhecido';
    return `${e.name || 'Error'}: ${e.message || e}`;
}

// Verificação de suporte em etapas, cada uma com uma mensagem ESPECÍFICA -
// evita deixar o usuário travado numa tela de carregamento sem saber por quê.
async function checkARSupport() {
    if (!window.isSecureContext) {
        showWarning(
            `A RA por câmera precisa de um contexto seguro (HTTPS ou localhost). Esta página ` +
            `foi carregada via "${location.protocol}//${location.host}", que não é seguro. ` +
            `Sirva os arquivos com HTTPS (ex.: um túnel como ngrok/Cloudflare Tunnel, ou ` +
            `hospedagem com certificado válido).`
        );
        return;
    }

    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
        showWarning(
            'Este navegador não expõe acesso à câmera (getUserMedia indisponível). Tente um ' +
            'navegador atualizado, como Chrome, Safari ou Firefox.'
        );
        return;
    }

    createARButton();
}

function createARButton() {
    const button = document.createElement('button');
    button.id = 'ar-button';
    button.textContent = 'Ver em RA';
    arContainer.appendChild(button);

    const hint = document.createElement('a');
    hint.id = 'ar-marker-link';
    hint.href = AR_TARGET_IMAGE_URL;
    hint.target = '_blank';
    hint.rel = 'noopener';
    hint.textContent = 'Ver foto de referência da maquete';
    arContainer.appendChild(hint);

    arContainer.classList.add('ready');

    button.addEventListener('click', () => {
        if (arActive) {
            stopARSession(button);
        } else {
            startARSession(button);
        }
    });
}

async function startARSession(button) {
    if (!modelObject) {
        showWarning('O modelo 3D ainda está carregando. Aguarde um instante e tente de novo.');
        return;
    }
    button.disabled = true;
    button.textContent = 'Iniciando câmera...';
    if (arWarning) arWarning.style.display = 'none';

    try {
        let MindARThree;
        try {
            ({ MindARThree } = await loadMindAR()); // já vem do cache se o pré-carregamento terminou
        } catch (e) {
            throw new Error('não foi possível baixar a biblioteca MindAR (verifique a internet). ' + describeError(e));
        }
        setupARScene(MindARThree);
        await mindar.start(); // pede a câmera, carrega o targets.mind e inicia o rastreamento
    } catch (err) {
        console.error('Falha ao iniciar a RA:', err);
        const msg = 'Não foi possível iniciar a RA: ' + describeError(err);
        if (infoEl) infoEl.textContent = msg;
        showWarning(msg);
        teardownAR();
        button.disabled = false;
        button.textContent = 'Ver em RA';
        return;
    }

    arActive = true;
    button.disabled = false;
    button.textContent = 'Sair da RA';

    // Modo "de mesa" some enquanto a RA está ativa
    renderer.domElement.style.display = 'none';
    controls.enabled = false;
    if (infoEl) infoEl.textContent = AR_INFO_TEXT;
}

function stopARSession(button) {
    arActive = false;
    const btn = button || document.getElementById('ar-button');
    if (btn) btn.textContent = 'Ver em RA';

    teardownAR();

    renderer.domElement.style.display = 'block';
    controls.enabled = true;
    if (infoEl) infoEl.textContent = DEFAULT_INFO_TEXT;
}

// Para a câmera (apaga o LED) e descarta tudo para a próxima sessão começar limpa.
function teardownAR() {
    if (mindar) {
        try { mindar.stop(); } catch (e) { console.warn(e); }
        try { mindar.renderer.dispose(); } catch (e) { /* ignora */ }
    }
    if (arContainer3D) {
        arContainer3D.querySelectorAll('video').forEach((v) => {
            const stream = v.srcObject;
            if (stream) stream.getTracks().forEach((t) => t.stop());
        });
        arContainer3D.remove();
    }
    mindar = null;
    arAnchor = null;
    arFollow = null;
    arFollowReady = false;
    arMesh = null;
    arContainer3D = null;
}

function setupARScene(MindARThree) {
    // Contêiner onde o MindAR coloca o vídeo da câmera e o canvas 3D.
    // z-index 1: fica abaixo dos botões (que usam z-index 10+).
    arContainer3D = document.createElement('div');
    arContainer3D.style.cssText = 'position:fixed;inset:0;z-index:1;overflow:hidden;background:#000;';
    document.body.appendChild(arContainer3D);

    mindar = new MindARThree({
        container: arContainer3D,
        imageTargetSrc: AR_TARGET_MIND_URL,
        maxTrack: 1,
        filterMinCF: AR_FILTER_MIN_CF,
        filterBeta: AR_FILTER_BETA,
        warmupTolerance: AR_WARMUP_TOLERANCE,
        missTolerance: AR_MISS_TOLERANCE,            // só uma imagem-alvo: menos processamento por frame
        uiLoading: 'no',
        uiScanning: 'no',
        uiError: 'no'
    });

    mindar.renderer.setPixelRatio(Math.min(window.devicePixelRatio, AR_PIXEL_RATIO));

    const { scene: arScene } = mindar;
    arScene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
    const arDirLight = new THREE.DirectionalLight(0xffffff, 1);
    arDirLight.position.set(1, 1, 1);
    arScene.add(arDirLight);

    // A capivara fica dentro de arAnchor.group; o MindAR atualiza a posição desse
    // grupo a cada frame para acompanhar a imagem-alvo.
    arAnchor = mindar.addAnchor(0);

    if (modelObject) {
        // No MindAR a imagem fica no plano XY e o "para cima" é o eixo Z
        // (diferente do AR.js/Hiro, onde era o Y). Por isso a capivara entra num
        // grupo "em pé" girado 90° em X; a rotação automática continua sendo
        // aplicada só no arMesh, dentro desse grupo.
        const upright = new THREE.Group();
        upright.rotation.x = Math.PI / 2;
        // arFollow fica direto na cena (não dentro de arAnchor.group): a cada
        // quadro ele é movido suavemente até a pose da âncora (ver updateARFollow).
        arFollow = new THREE.Group();
        arFollow.visible = false;
        arFollow.add(upright);
        arScene.add(arFollow);

        arMesh = modelObject.clone(true);
        const scale = AR_MODEL_SCALE / modelMaxDim;
        arMesh.scale.setScalar(scale);

        // Eixo vertical: apoiar a capivara sobre a imagem (ver INVERT_MODEL_Y no topo).
        const verticalOffset = (modelSize.y / 2) * scale;
        arMesh.position.y = INVERT_MODEL_Y ? -verticalOffset : verticalOffset;

        upright.add(arMesh);
    }

    // Avisos quando a imagem-alvo é encontrada / perdida
    arAnchor.onTargetFound = () => {
        arFollowReady = false; // ao reencontrar a imagem, posiciona direto (sem "voar" da última posição)
        if (infoEl) infoEl.textContent = 'Imagem encontrada!';
    };
    arAnchor.onTargetLost = () => {
        if (infoEl) infoEl.textContent = AR_INFO_TEXT;
    };
}

// ---------- Loop de renderização ----------
const _tp = new THREE.Vector3();
const _tq = new THREE.Quaternion();
const _ts = new THREE.Vector3();

// Move arFollow suavemente em direção à pose atual da âncora do MindAR.
function updateARFollow(delta) {
    if (!arAnchor || !arFollow) return;
    if (!arAnchor.group.visible) {
        arFollow.visible = false;
        arFollowReady = false;
        return;
    }
    arAnchor.group.matrix.decompose(_tp, _tq, _ts);
    if (!arFollowReady) {
        arFollow.position.copy(_tp);
        arFollow.quaternion.copy(_tq);
        arFollow.scale.copy(_ts);
        arFollowReady = true;
    } else {
        // Fator exponencial: resultado igual em 30, 60 ou 120 fps
        const a = 1 - Math.exp(-AR_SMOOTHING * delta);
        arFollow.position.lerp(_tp, a);
        arFollow.quaternion.slerp(_tq, a);
        arFollow.scale.lerp(_ts, a);
    }
    arFollow.visible = true;
}

function animate() {
    requestAnimationFrame(animate);
    // Limita o delta: depois de uma pausa (aba em segundo plano, carregamento
    // pesado) o modelo não dá um "salto" de rotação.
    const delta = Math.min(clock.getDelta(), 0.1);
    if (document.hidden) return; // aba escondida: não gasta GPU

    // ---------- MOVIMENTO: rotação automática do modelo ----------
    // Gira o mesh que está visível no momento (o de mesa ou o da RA) no
    // eixo configurado em MODEL_ROTATION_AXIS, lá no topo do arquivo. Fica
    // independente do arraste manual do OrbitControls, que continua
    // funcionando normalmente por cima disso no modo "de mesa".
    if (MODEL_AUTO_ROTATE) {
        const activeMesh = arActive ? arMesh : previewMesh;
        if (activeMesh) {
            activeMesh.rotation[MODEL_ROTATION_AXIS] += MODEL_ROTATION_SPEED * delta;
        }
    }

    if (arActive) {
        // O rastreamento roda dentro do MindAR; aqui só desenhamos a cena.
        updateARFollow(delta);
        if (mindar) mindar.renderer.render(mindar.scene, mindar.camera);
    } else {
        controls.update();
        renderer.render(scene, camera);
    }
}
animate();

// ---------- Responsividade (modo "de mesa") ----------
let resizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }, 100);
});

// ==========================================================================
// ---------- QR Code de acesso rápido ----------
// ==========================================================================
let qrRendered = false;

function renderQRCode() {
    const target = document.getElementById('qrcode');
    if (!target || typeof QRCode === 'undefined') return;
    target.innerHTML = '';
    new QRCode(target, {
        text: window.location.href,
        width: 180,
        height: 180,
        colorDark: '#0b0d0f',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
    });
    const urlEl = document.getElementById('qr-url');
    if (urlEl) urlEl.textContent = window.location.href;
    qrRendered = true;
}

const qrToggle = document.getElementById('qr-toggle');
const qrPanel = document.getElementById('qr-panel');
if (qrToggle && qrPanel) {
    qrToggle.addEventListener('click', () => {
        const isOpen = qrPanel.classList.toggle('open');
        if (isOpen && !qrRendered) renderQRCode();
    });
    const qrClose = document.getElementById('qr-close');
    if (qrClose) qrClose.addEventListener('click', () => qrPanel.classList.remove('open'));
}
