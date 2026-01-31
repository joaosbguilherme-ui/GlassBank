import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, collection, query, where, onSnapshot, runTransaction, serverTimestamp, limit, getDocs } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBkl7Vt5WHMoiU3mThXiG7hAzv1T0FvSRI",
  authDomain: "glassbank-c411b.firebaseapp.com",
  projectId: "glassbank-c411b",
  storageBucket: "glassbank-c411b.firebasestorage.app",
  messagingSenderId: "222854977565",
  appId: "1:222854977565:web:c654f9a0dbf47665f7cef4"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ======================================================
// ⚠️ ATENÇÃO: COLOQUE O ID DA PREFEITURA AQUI
const CITY_HALL_ID = "DIGITE_O_ID_DA_PREFEITURA_AQUI"; 
// ======================================================

let currentUserData = null;
let html5QrcodeScanner = null;
let currentTaxRate = 0.02;

function generateShortId() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for(let i=0; i<6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

const showToast = (msg, type = 'success') => {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
};

// CORREÇÃO: Função navTo robusta que garante reset das classes
window.navTo = (sectionId) => {
    // Esconde todas as sections
    document.querySelectorAll('section').forEach(s => s.classList.add('hidden'));
    
    // Identifica o alvo (aceita "dashboard" ou "dashboard-section")
    const targetId = sectionId.endsWith('-section') ? sectionId : sectionId + '-section';
    const target = document.getElementById(targetId);
    
    if(target) {
        target.classList.remove('hidden');
        if(sectionId === 'qr-scan') startScanner();
        else stopScanner();
    } else {
        console.error("Tela não encontrada:", sectionId);
    }
};

window.toggleAuth = (mode) => {
    const isRegister = mode === 'register';
    document.getElementById('fullname').style.display = isRegister ? 'block' : 'none';
    document.getElementById('role-select').style.display = isRegister ? 'block' : 'none';
    document.getElementById('auth-btn').innerText = isRegister ? 'Cadastrar' : 'Entrar';
    document.getElementById('auth-form').dataset.mode = mode;
    
    // Atualiza botões visuais
    document.querySelectorAll('.auth-tabs button').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
};

window.toggleHistory = () => {
    document.getElementById('history-panel').classList.toggle('hidden');
};

// --- AUTENTICAÇÃO ---
const authForm = document.getElementById('auth-form');
authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = authForm.dataset.mode || 'login';
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    
    try {
        if (mode === 'register') {
            const name = document.getElementById('fullname').value;
            const role = document.getElementById('role-select').value;
            const shortId = generateShortId();
            
            const userCred = await createUserWithEmailAndPassword(auth, email, password);
            await setDoc(doc(db, "users", userCred.user.uid), {
                name: name, email: email, role: role, shortId: shortId,
                balance: 1000.00, createdAt: serverTimestamp()
            });
            showToast("Bem-vindo! ID: " + shortId);
        } else {
            await signInWithEmailAndPassword(auth, email, password);
        }
    } catch (error) {
        showToast("Erro: " + error.message, 'error');
    }
});

// CORREÇÃO: Adicionando lógica do botão de Sair (Logout)
document.getElementById('logout-btn').addEventListener('click', () => {
    signOut(auth).then(() => {
        showToast("Você saiu da conta.");
        navTo('auth');
    }).catch((error) => {
        showToast("Erro ao sair.", "error");
    });
});

// --- LOAD DATA ---
onAuthStateChanged(auth, (user) => {
    if (user) {
        // CORREÇÃO: Força navegação para dashboard ao logar
        navTo('dashboard');
        
        onSnapshot(doc(db, "users", user.uid), (docSnap) => {
            if (docSnap.exists()) {
                currentUserData = docSnap.data();
                currentUserData.uid = user.uid;
                
                if (!currentUserData.shortId) {
                    updateDoc(doc(db, "users", user.uid), { shortId: generateShortId() });
                }

                document.getElementById('user-name').innerText = currentUserData.name;
                document.getElementById('user-role').innerText = currentUserData.role === 'merchant' ? 'Vendedor' : 'Usuário';
                document.getElementById('user-balance').innerText = `R$ ${currentUserData.balance.toFixed(2)}`;
                document.getElementById('user-short-id').innerText = currentUserData.shortId || "...";
                
                // CORREÇÃO: Encode URI para evitar quebra com espaços no nome
                document.getElementById('user-avatar').src = `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUserData.name)}&background=random`;

                // Admin UI
                if (currentUserData.role === 'admin') {
                    document.getElementById('admin-btn').classList.remove('hidden');
                    loadAdminData();
                } else {
                    document.getElementById('admin-btn').classList.add('hidden');
                }
            }
        });

        listenToTransactions(user.uid);
        syncTaxRate();

    } else {
        navTo('auth');
        currentUserData = null;
    }
});

// --- SISTEMA DE IMPOSTOS ---
function syncTaxRate() {
    // CORREÇÃO: Evita crash se o ID da prefeitura não estiver configurado no código
    if (!CITY_HALL_ID || CITY_HALL_ID.length < 5) return;

    onSnapshot(doc(db, "users", CITY_HALL_ID), (docSnap) => {
        if(docSnap.exists()) {
            const data = docSnap.data();
            currentTaxRate = data.customTax !== undefined ? data.customTax : 0.02;
            
            document.getElementById('current-tax-display').innerText = (currentTaxRate * 100).toFixed(1);
            document.getElementById('tax-percent-display').innerText = (currentTaxRate * 100).toFixed(1);
        }
    }, (error) => {
        console.warn("Sem permissão para ler dados da prefeitura ou ID inválido.");
    });
}

window.updateTaxRate = async () => {
    const inputVal = parseFloat(document.getElementById('new-tax-rate').value);
    if(isNaN(inputVal) || inputVal < 0 || inputVal > 50) {
        return showToast("Taxa inválida (0 a 50%)", "error");
    }
    const newRate = inputVal / 100;
    
    try {
        await updateDoc(doc(db, "users", CITY_HALL_ID), {
            customTax: newRate
        });
        showToast(`Imposto atualizado para ${inputVal}%`);
    } catch (e) {
        showToast("Erro: Permissão negada.", "error");
    }
};

// --- TRANSAÇÕES ---
async function getUidFromShortId(shortId) {
    const q = query(collection(db, "users"), where("shortId", "==", shortId));
    const snapshot = await getDocs(q);
    if (snapshot.empty) return null;
    return { uid: snapshot.docs[0].id, data: snapshot.docs[0].data() };
}

document.getElementById('transfer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const shortId = document.getElementById('dest-id').value.toUpperCase().trim();
    const amt = parseFloat(document.getElementById('amount').value);
    
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.innerText = "Processando...";
    
    await processTransaction(shortId, amt);
    
    btn.disabled = false;
    btn.innerText = "Confirmar Envio";
});

async function processTransaction(receiverShortId, amount) {
    if (!currentUserData) return showToast("Erro: Usuário não carregado", "error");
    if (amount <= 0) return showToast("Valor inválido", "error");

    try {
        const receiverInfo = await getUidFromShortId(receiverShortId);
        if (!receiverInfo) throw new Error("ID Destinatário não encontrado!");
        if (receiverInfo.uid === currentUserData.uid) throw new Error("Você não pode enviar para si mesmo.");

        const tax = amount * currentTaxRate;
        const totalDeduction = amount + tax;

        await runTransaction(db, async (transaction) => {
            const senderRef = doc(db, "users", currentUserData.uid);
            const senderDoc = await transaction.get(senderRef);
            if (!senderDoc.exists()) throw "Remetente não existe!";

            const senderBalance = senderDoc.data().balance;
            if (senderBalance < totalDeduction) throw "Saldo insuficiente (Valor + Taxa)";

            const receiverRef = doc(db, "users", receiverInfo.uid);
            const receiverDoc = await transaction.get(receiverRef);
            if (!receiverDoc.exists()) throw "Destinatário inválido!";

            transaction.update(senderRef, { balance: senderBalance - totalDeduction });
            transaction.update(receiverRef, { balance: receiverDoc.data().balance + amount });

            // Envia imposto apenas se ID for válido
            if (CITY_HALL_ID && CITY_HALL_ID.length > 5) {
                const cityRef = doc(db, "users", CITY_HALL_ID);
                const cityDoc = await transaction.get(cityRef);
                if (cityDoc.exists()) {
                    transaction.update(cityRef, { balance: cityDoc.data().balance + tax });
                }
            }

            const txRef = doc(collection(db, "transactions"));
            transaction.set(txRef, {
                senderId: currentUserData.uid,
                senderName: currentUserData.name,
                receiverId: receiverInfo.uid,
                receiverName: receiverInfo.data.name,
                amount: amount,
                tax: tax,
                taxRate: currentTaxRate,
                participants: [currentUserData.uid, receiverInfo.uid],
                timestamp: serverTimestamp()
            });
        });

        showToast("✅ Transferência realizada com sucesso!");
        document.getElementById('transfer-form').reset();
        document.getElementById('tax-calc').innerText = "R$ 0,00";
        navTo('dashboard');

    } catch (e) {
        console.error("Erro na transação:", e);
        showToast("Falha: " + (e.message || e), "error");
    }
}

document.getElementById('amount').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value) || 0;
    document.getElementById('tax-calc').innerText = `R$ ${(val * currentTaxRate).toFixed(2)}`;
});

// --- QR CODE ---
window.generateQR = () => {
    const amt = document.getElementById('qr-amount').value;
    const img = document.getElementById('qr-image');
    
    if(!amt || amt <= 0) {
        img.style.display = 'none';
        return;
    }

    const payload = JSON.stringify({ sid: currentUserData.shortId, amt: parseFloat(amt) });
    const apiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(payload)}`;
    
    img.src = apiUrl;
    img.style.display = 'block';
};

function startScanner() {
    // Verifica se já existe instância para evitar erro de inicialização dupla
    if (html5QrcodeScanner) {
         // Opcional: reiniciar ou apenas focar
         return; 
    }
    
    html5QrcodeScanner = new Html5Qrcode("reader");
    html5QrcodeScanner.start(
        { facingMode: "environment" }, 
        { fps: 10, qrbox: 250 },
        async (decodedText) => {
            try {
                const data = JSON.parse(decodedText);
                if(data.sid && data.amt) {
                    stopScanner();
                    const rData = await getUidFromShortId(data.sid);
                    if(rData) {
                        document.getElementById('scan-result').classList.remove('hidden');
                        document.getElementById('scan-amt').innerText = data.amt;
                        document.getElementById('scan-to-name').innerText = rData.data.name;
                        
                        const btn = document.getElementById('confirm-pay-btn');
                        const newBtn = btn.cloneNode(true);
                        btn.parentNode.replaceChild(newBtn, btn);
                        
                        newBtn.addEventListener('click', () => processTransaction(data.sid, data.amt));
                    } else {
                        showToast("Usuário não encontrado", "error");
                        setTimeout(startScanner, 2000); // Tenta de novo após 2s
                    }
                }
            } catch (e) { console.log("Lendo..."); }
        },
        (errorMessage) => {}
    ).catch(err => {
        showToast("Erro na câmera. Verifique permissões.", "error");
    });
}

function stopScanner() {
    if(html5QrcodeScanner) {
        html5QrcodeScanner.stop().then(() => {
            html5QrcodeScanner.clear();
            html5QrcodeScanner = null;
        }).catch(()=>{});
    }
}

window.resetScanner = () => {
    document.getElementById('scan-result').classList.add('hidden');
    startScanner();
};

function loadAdminData() {
    if (!CITY_HALL_ID || CITY_HALL_ID.length < 5) return;

    onSnapshot(doc(db, "users", CITY_HALL_ID), (docSnap) => {
        if(docSnap.exists()) {
            document.getElementById('city-hall-balance').innerText = `R$ ${docSnap.data().balance.toFixed(2)}`;
        }
    }, error => console.log("Admin access error"));

    const q = query(collection(db, "users"), limit(10));
    onSnapshot(q, (snap) => {
        const list = document.getElementById('admin-user-list');
        list.innerHTML = "";
        snap.forEach(d => {
            const u = d.data();
            list.innerHTML += `<li>${u.name} (${u.shortId || '-'}) - R$ ${u.balance.toFixed(2)}</li>`;
        });
    });
}

function listenToTransactions(uid) {
    const q = query(collection(db, "transactions"), where("participants", "array-contains", uid), limit(20));
    onSnapshot(q, (s) => {
        const l = document.getElementById('transaction-list');
        l.innerHTML = "";
        s.forEach(d => {
            const t = d.data();
            const isS = t.senderId === uid;
            l.innerHTML += `<li style="border-bottom:1px solid #333; padding:5px; display:flex; justify-content:space-between;">
                <span>${isS ? 'Enviou' : 'Recebeu'}</span>
                <span style="color:${isS?'red':'green'}">${isS?'-':'+'} R$ ${t.amount}</span>
            </li>`;
        });
    });
}