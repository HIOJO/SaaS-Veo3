import React, { useState, useRef, useEffect, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const MAX_PROMPTS_POR_LOTE = 500;
const MAX_RETRIES = 5;
const POLL_INTERVAL_MS = 15000;
const MIN_BLOB_SIZE = 1000;

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------
function idbSet(key, val) {
  return new Promise((resolve) => {
    const req = indexedDB.open("DarklineDB", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("store");
    req.onsuccess = () => {
      const tx = req.result.transaction("store", "readwrite");
      tx.objectStore("store").put(val, key);
      tx.oncomplete = () => resolve(true);
    };
    req.onerror = () => resolve(false);
  });
}

function idbGet(key) {
  return new Promise((resolve) => {
    const req = indexedDB.open("DarklineDB", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("store");
    req.onsuccess = () => {
      const tx = req.result.transaction("store", "readonly");
      const getReq = tx.objectStore("store").get(key);
      getReq.onsuccess = () => resolve(getReq.result ?? null);
      getReq.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------
function sanitizePrompt(prompt) {
  let name = prompt.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  name = name.replace(/[^a-z0-9\s]/g, "");
  name = name.replace(/\s+/g, "_").replace(/^_+|_+$/g, "");
  return name.substring(0, 50) || "prompt";
}

function gerarJobId() {
  return `job_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
function App() {
  const [inputText, setInputText]         = useState('');
  const [directoryHandle, setDirectoryHandle] = useState(null);
  const [directoryName, setDirectoryName] = useState('Nenhuma pasta selecionada');
  const [queue, setQueue]                 = useState([]);
  const [workers, setWorkers]             = useState(4);

  // Ref para acessar directoryHandle dentro de callbacks sem stale closure
  const dirHandleRef = useRef(null);
  useEffect(() => { dirHandleRef.current = directoryHandle; }, [directoryHandle]);

  // ---------------------------------------------------------------------------
  // Carregar pasta salva ao iniciar
  // ---------------------------------------------------------------------------
  useEffect(() => {
    idbGet('savedFolder').then((handle) => {
      if (handle) {
        setDirectoryHandle(handle);
        setDirectoryName(handle.name + " (Definida Permanentemente)");
      }
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Selecionar pasta
  // ---------------------------------------------------------------------------
  const handleSelectFolder = async () => {
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      setDirectoryHandle(dirHandle);
      setDirectoryName(dirHandle.name + " (Definida Permanentemente)");
      await idbSet('savedFolder', dirHandle);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Erro ao selecionar pasta:', err);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Salvar vídeo no disco
  // ---------------------------------------------------------------------------
  const saveVideoToFileSystem = async (dirHandle, videoUrl, filename) => {
    try {
      const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        await dirHandle.requestPermission({ mode: 'readwrite' });
      }

      const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
      const writable   = await fileHandle.createWritable();

      const response = await fetch(videoUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status} ao baixar vídeo`);

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        throw new Error("Servidor retornou HTML em vez do vídeo");
      }

      const blob = await response.blob();
      if (blob.size < MIN_BLOB_SIZE) {
        throw new Error(`Arquivo muito pequeno (${blob.size} bytes)`);
      }

      await writable.write(blob);
      await writable.close();
      return true;
    } catch (err) {
      console.error("Erro no download/salvamento:", err.message);
      return false;
    }
  };

  // ---------------------------------------------------------------------------
  // Adicionar prompts à fila
  // ---------------------------------------------------------------------------
  const handleGenerate = async () => {
    const texto = inputText.trim();
    if (!texto) return alert("Digite ao menos um prompt!");
    if (!directoryHandle) return alert("Selecione a pasta de destino primeiro!");

    try {
      const perm = await directoryHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') await directoryHandle.requestPermission({ mode: 'readwrite' });
    } catch {
      return alert("Permissão negada! Precisamos de acesso para salvar os vídeos.");
    }

    const lines = texto
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .slice(0, MAX_PROMPTS_POR_LOTE);

    if (lines.length === 0) return;

    setQueue(prev => {
      const startIndex = prev.length;
      const newItems = lines.map((line, i) => ({
        id: gerarJobId(),
        prompt: line,
        globalIndex: startIndex + i + 1,
        status: 'Aguardando na fila',
        statusClass: '',
        done: false,
        processing: false,
        retries: 0,
      }));
      return [...prev, ...newItems];
    });

    setInputText('');
  };

  // ---------------------------------------------------------------------------
  // Atualizar item da fila
  // ---------------------------------------------------------------------------
  const updateQueueItem = useCallback((id, updates) => {
    setQueue(prev => prev.map(item => item.id === id ? { ...item, ...updates } : item));
  }, []);

  // ---------------------------------------------------------------------------
  // Orquestrador de workers
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const ativos   = queue.filter(q => q.processing && !q.done).length;
    const vagas    = workers - ativos;
    if (vagas <= 0) return;

    const pendentes = queue.filter(
      item => !item.done && !item.processing && item.status.startsWith('Aguardando na fila')
    );

    pendentes.slice(0, vagas).forEach(item => processNextItem(item));
  }, [queue, workers]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Processar um item
  // ---------------------------------------------------------------------------
  const processNextItem = async (item) => {
    updateQueueItem(item.id, { status: 'Na fila da API (Nuvem)', statusClass: 'status-active', processing: true });

    const reportFailure = async (errorMsg) => {
      const msgCurta = String(errorMsg).substring(0, 30);

      if (item.retries < MAX_RETRIES) {
        const tentativa = item.retries + 2;
        updateQueueItem(item.id, {
          status: `Regerando... (Falha: ${msgCurta})`,
          statusClass: 'status-warning',
          retries: item.retries + 1,
          processing: false,
          done: false,
        });
        setTimeout(() => {
          updateQueueItem(item.id, { status: `Aguardando na fila (Tentativa ${tentativa})` });
        }, 5000);
      } else {
        updateQueueItem(item.id, {
          status: `Desistiu: ${msgCurta}`,
          statusClass: '',
          done: true,
          processing: false,
        });

        // Registra falha em arquivo de log
        try {
          const dh = dirHandleRef.current;
          if (dh) {
            const fileHandle   = await dh.getFileHandle('prompts_falhados.txt', { create: true });
            const file         = await fileHandle.getFile();
            const existingText = await file.text();
            const writable     = await fileHandle.createWritable();
            const paddedIndex  = String(item.globalIndex).padStart(4, '0');
            await writable.write(existingText + `Vídeo #${paddedIndex} - ${item.prompt}\n`);
            await writable.close();
          }
        } catch (e) {
          console.error("Erro ao salvar log de falhas:", e);
        }
      }
    };

    try {
      const res = await fetch("/api/solicitar_token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: item.id,
          prompt: item.prompt,
          capturar_bearer: item.retries > 0,
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`API retornou ${res.status}: ${detail.substring(0, 60)}`);
      }

      // Polling de status
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/status_video/${item.id}`);
          if (!statusRes.ok) return;

          const data = await statusRes.json();
          const status = data.status ?? '';

          // Mapa de status → texto amigável
          const statusMap = {
            gerando:            'Renderizando no Veo3...',
            iniciando:          'Iniciando requisição...',
            aguardando_extensao:'Aguardando Extensão...',
            aguardando_bearer:  'Interceptando Bearer...',
            aguardando_recaptcha:'Resolvendo reCAPTCHA...',
          };

          if (statusMap[status]) {
            updateQueueItem(item.id, { status: statusMap[status] });
          }

          if (data.status === 'pronto' && data.video_url) {
            clearInterval(pollInterval);
            updateQueueItem(item.id, { status: 'Baixando para o SSD...' });

            const paddedIndex = String(item.globalIndex).padStart(4, '0');
            const safeName    = sanitizePrompt(item.prompt);
            const filename    = `vid_${paddedIndex}_${safeName}.mp4`;
            const videoUrl    = data.video_url;

            const success = await saveVideoToFileSystem(dirHandleRef.current, videoUrl, filename);
            if (success) {
              updateQueueItem(item.id, { status: 'Concluído e Salvo!', statusClass: '', done: true, processing: false });
            } else {
              reportFailure("Erro ao baixar o arquivo final");
            }

          } else if (status === 'sem_pedidos_recentes') {
            clearInterval(pollInterval);
            reportFailure("Sessão perdida na nuvem");

          } else if (status.startsWith('erro')) {
            clearInterval(pollInterval);
            reportFailure(status);
          }
        } catch (e) {
          console.error("Erro no polling:", e);
        }
      }, POLL_INTERVAL_MS);

    } catch (err) {
      reportFailure(err.message || "Falha de conexão com a API");
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const pendentes = queue.filter(q => !q.done).length;

  return (
    <div className="app-container">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-dot"></div>
          Darkline Station
        </div>
        <ul className="nav-menu">
          <li className="nav-item active">Produção em Lote</li>
          <li className="nav-item">Configurações</li>
        </ul>
      </aside>

      <main className="main-content">
        <header className="header">
          <h1>Central de Produção</h1>
          <p>Cole sua lista de prompts e o motor trabalhará em sequência.</p>
        </header>

        <section className="control-panel">
          <div className="input-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <label style={{ margin: 0 }}>
                Lista de Prompts (Um por linha, máx. {MAX_PROMPTS_POR_LOTE})
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <label style={{ margin: 0 }}>Workers Paralelos:</label>
                <select
                  style={{ padding: '4px', borderRadius: '4px', backgroundColor: 'var(--bg-surface)', color: 'var(--text-main)', border: '1px solid var(--border-color)' }}
                  value={workers}
                  onChange={(e) => setWorkers(parseInt(e.target.value, 10))}
                >
                  <option value={1}>1 Vídeo</option>
                  <option value={2}>2 Vídeos</option>
                  <option value={3}>3 Vídeos</option>
                  <option value={4}>4 Vídeos</option>
                </select>
              </div>
            </div>
            <textarea
              className="prompt-input"
              placeholder={"Prompt 1...\nPrompt 2...\nPrompt 3..."}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              style={{ minHeight: '150px' }}
            />
          </div>

          <div className="actions">
            <button className="btn-primary" onClick={handleGenerate}>
              Adicionar à Fila
            </button>
            <button className="btn-secondary" onClick={handleSelectFolder}>
              Mudar Pasta de Destino
            </button>
            <div className="folder-status">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              {directoryName}
            </div>
          </div>
        </section>

        <section className="queue-section">
          <h2>Fila Ativa ({pendentes} pendentes)</h2>
          <div className="queue-list">
            {queue.length === 0 ? (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Nenhum vídeo na fila.</p>
            ) : (
              queue.map((item) => (
                <div className="queue-item" key={item.id} style={{ opacity: item.done ? 0.6 : 1 }}>
                  <div className="queue-item-info">
                    <h3>Vídeo #{String(item.globalIndex).padStart(4, '0')}</h3>
                    <p>{item.prompt}</p>
                  </div>
                  <div className={`queue-item-status ${item.statusClass}`}>
                    {item.status}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
