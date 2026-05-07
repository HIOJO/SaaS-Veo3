import React, { useState, useRef, useEffect } from 'react';

function App() {
  const [inputText, setInputText] = useState('');
  const [directoryHandle, setDirectoryHandle] = useState(null);
  const [directoryName, setDirectoryName] = useState('Nenhuma pasta selecionada');
  const [queue, setQueue] = useState([]);
  const [workers, setWorkers] = useState(4); // Padrão 4 workers

  // IndexedDB Helpers
  const idbSet = async (key, val) => {
    return new Promise((resolve) => {
        const req = indexedDB.open("DarklineDB", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("store");
        req.onsuccess = () => {
            const tx = req.result.transaction("store", "readwrite");
            tx.objectStore("store").put(val, key);
            tx.oncomplete = () => resolve(true);
        };
    });
  };

  const idbGet = async (key) => {
    return new Promise((resolve) => {
        const req = indexedDB.open("DarklineDB", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("store");
        req.onsuccess = () => {
            const tx = req.result.transaction("store", "readonly");
            const getReq = tx.objectStore("store").get(key);
            getReq.onsuccess = () => resolve(getReq.result);
        };
    });
  };

  // Carregar Pasta Salva ao Iniciar
  useEffect(() => {
    idbGet('savedFolder').then(async (handle) => {
        if (handle) {
            setDirectoryHandle(handle);
            setDirectoryName(handle.name + " (Definida Permanentemente)");
        }
    });
  }, []);

  // Selecionar Pasta
  const handleSelectFolder = async () => {
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      setDirectoryHandle(dirHandle);
      setDirectoryName(dirHandle.name + " (Definida Permanentemente)");
      await idbSet('savedFolder', dirHandle);
    } catch (err) {
      console.error('Usuário cancelou a seleção', err);
    }
  };

  // Salvar no Disco
  const saveVideoToFileSystem = async (dirHandle, videoUrl, filename) => {
    try {
      // Re-valida permissao
      if ((await dirHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
          await dirHandle.requestPermission({ mode: 'readwrite' });
      }
      
      const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      
      console.log(`Baixando video de: ${videoUrl}`);
      const response = await fetch(videoUrl);
      if (!response.ok) throw new Error("Erro HTTP ao baixar: " + response.status);
      
      const contentType = response.headers.get('content-type') || '';
      console.log(`Content-Type recebido: ${contentType}`);
      
      if (contentType.includes('text/html')) {
          throw new Error("O servidor retornou uma pagina HTML de erro em vez do video.");
      }
      
      const blob = await response.blob();
      console.log(`Tamanho baixado: ${blob.size} bytes`);
      
      if (blob.size < 1000) {
          throw new Error("Arquivo muito pequeno (provavelmente bloqueado ou vazio)");
      }
      
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (err) {
      console.error("Erro no download/salvamento:", err);
      return false;
    }
  };

  const sanitizePrompt = (prompt) => {
    let name = prompt.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    name = name.replace(/[^a-z0-9\s]/g, "");
    name = name.replace(/\s+/g, "_").replace(/^_+|_+$/g, "");
    return name.substring(0, 50) || "prompt";
  };

  // Adicionar a Fila
  const handleGenerate = async () => {
    if (!inputText.trim()) return alert("Digite ao menos um prompt!");
    if (!directoryHandle) return alert("Selecione a pasta de destino primeiro!");

    // Se carregamos a pasta salva, precisamos confirmar a permissão invisível do Chrome
    try {
      if ((await directoryHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
          await directoryHandle.requestPermission({ mode: 'readwrite' });
      }
    } catch (e) {
      return alert("Permissão negada! Precisamos de acesso para salvar os vídeos.");
    }

    const lines = inputText.split('\n').filter(line => line.trim().length > 0);
    
    // O startIndex baseado no tamanho atual da fila
    const startIndex = queue.length;
    
    const newItems = lines.map((line, i) => {
      const globalIndex = startIndex + i + 1;
      return {
        id: `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        prompt: line.trim(),
        globalIndex: globalIndex, // Salva o numero XXXX
        status: 'Aguardando na fila',
        statusClass: '',
        done: false,
        processing: false,
        retries: 0
      };
    });

    setQueue(prev => [...prev, ...newItems]);
    setInputText('');
  };

  const updateQueueItem = (id, updates) => {
    setQueue(prev => prev.map(item => item.id === id ? { ...item, ...updates } : item));
  };

  // Orquestrador de Workers Paralelos
  useEffect(() => {
    const activeWorkers = queue.filter(q => q.processing && !q.done).length;
    
    // Se temos vagas nos workers, puxa mais jobs
    if (activeWorkers < workers) {
      const availableSpots = workers - activeWorkers;
      const pendingItems = queue.filter(item => !item.done && !item.processing && item.status.includes('Aguardando na fila'));
      
      const itemsToStart = pendingItems.slice(0, availableSpots);
      
      itemsToStart.forEach(item => {
        processNextItem(item);
      });
    }
  }, [queue, workers]);

  const processNextItem = async (item) => {
    updateQueueItem(item.id, { status: 'Na fila da API (Nuvem)', statusClass: 'status-active', processing: true });

    const reportFailure = async (errorMsg) => {
      if (item.retries < 5) {
        updateQueueItem(item.id, { 
            status: `Regerando... (Falha anterior: ${errorMsg.substring(0, 20)})`, 
            statusClass: 'status-warning',
            retries: item.retries + 1,
            processing: false,
            done: false 
        });
        setTimeout(() => {
            updateQueueItem(item.id, { status: 'Aguardando na fila (Tentativa ' + (item.retries + 2) + ')' });
        }, 5000); // 5s delay before retry
      } else {
        updateQueueItem(item.id, { status: `Desistiu: ${errorMsg.substring(0, 20)}`, statusClass: '', done: true, processing: false });
        
        try {
            const fileHandle = await directoryHandle.getFileHandle('prompts_falhados.txt', { create: true });
            const file = await fileHandle.getFile();
            const existingText = await file.text();
            
            const writable = await fileHandle.createWritable();
            const paddedIndex = String(item.globalIndex).padStart(4, '0');
            const newLine = `Vídeo #${paddedIndex} - ${item.prompt}\n`;
            
            await writable.write(existingText + newLine);
            await writable.close();
        } catch (e) {
            console.error("Erro ao salvar log de falhas", e);
        }
      }
    };

    try {
      const res = await fetch("/api/solicitar_token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: item.id, prompt: item.prompt, capturar_bearer: item.retries > 0 })
      });
      
      if (!res.ok) throw new Error("Erro de API no Frontend");

      // Polling Loop
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/status_video/${item.id}`);
          const data = await statusRes.json();
          
          let displayStatus = 'Interceptando chaves...';
          if (data.status === 'gerando') displayStatus = 'Renderizando no Veo3...';
          else if (data.status === 'iniciando') displayStatus = 'Iniciando requisição...';
          else if (data.status === 'aguardando_extensao') displayStatus = 'Aguardando Extensão...';
          
          if (!data.status.includes('erro') && data.status !== 'pronto') {
              updateQueueItem(item.id, { status: displayStatus });
          }

          if (data.status === 'pronto' && data.video_url) {
            clearInterval(pollInterval);
            updateQueueItem(item.id, { status: 'Baixando para o SSD...' });
            
            const paddedIndex = String(item.globalIndex).padStart(4, '0');
            const safeName = sanitizePrompt(item.prompt);
            const filename = `vid_${paddedIndex}_${safeName}.mp4`;
            
            const success = await saveVideoToFileSystem(directoryHandle, data.video_url, filename);
            
            if (success) {
                updateQueueItem(item.id, { status: 'Concluído e Salvo!', statusClass: '', done: true, processing: false });
            } else {
                reportFailure("Erro ao baixar o arquivo final");
            }
          } else if (data.status === 'sem_pedidos_recentes') {
            clearInterval(pollInterval);
            reportFailure("Sessão perdida na nuvem");
          } else if (data.status.includes('erro')) {
            clearInterval(pollInterval);
            reportFailure(data.status);
          }
        } catch (e) {
          console.error(e);
        }
      }, 15000);

    } catch (err) {
      reportFailure("Falha de conexão com a API");
    }
  };

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
                <label style={{ margin: 0 }}>Lista de Prompts (Um por linha)</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <label style={{ margin: 0 }}>Workers Paralelos:</label>
                    <select 
                        style={{ padding: '4px', borderRadius: '4px', backgroundColor: 'var(--bg-surface)', color: 'var(--text-main)', border: '1px solid var(--border-color)' }}
                        value={workers} 
                        onChange={(e) => setWorkers(parseInt(e.target.value))}
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
              placeholder="Prompt 1...&#10;Prompt 2...&#10;Prompt 3..."
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              style={{ minHeight: '150px' }}
            ></textarea>
          </div>

          <div className="actions">
            <button className="btn-primary" onClick={handleGenerate}>
              Adicionar à Fila
            </button>
            <button className="btn-secondary" onClick={handleSelectFolder}>
              Mudar Pasta de Destino
            </button>
            <div className="folder-status">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
              {directoryName}
            </div>
          </div>
        </section>

        <section className="queue-section">
          <h2>Fila Ativa ({queue.filter(q => !q.done).length} pendentes)</h2>
          <div className="queue-list">
            {queue.length === 0 ? (
              <p style={{color: 'var(--text-muted)', fontSize: '0.9rem'}}>Nenhum vídeo na fila.</p>
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
