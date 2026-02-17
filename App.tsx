
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ContactRow, AppStatus } from './types';
import { generateSpeech, decodeAudioToBuffer } from './services/geminiService';

const App: React.FC = () => {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [status, setStatus] = useState<AppStatus>(AppStatus.LOADING);
  const [errorMessage, setErrorMessage] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  
  // Persistent URL from localStorage
  const [csvUrl, setCsvUrl] = useState(() => {
    return localStorage.getItem('csv_url') || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSbq70IuS3Y_fD4jX0jB_vXp6i_V5_R7E7_qGv_vXp6i/pub?output=csv';
  });

  const audioContextRef = useRef<AudioContext | null>(null);

  // Parse CSV function
  const parseCSV = (csv: string): ContactRow[] => {
    const lines = csv.split('\n');
    return lines.slice(1).map(line => {
      // Basic CSV splitting handling quotes
      const columns = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => c.trim().replace(/^"|"$/g, ''));
      return {
        relatie: columns[0] || '',
        contactpersoon: columns[1] || '',
        onderwerp: columns[2] || '',
        telefoonnummer: columns[3] || ''
      };
    }).filter(row => row.contactpersoon && row.telefoonnummer);
  };

  const loadCSV = useCallback(async (url: string) => {
    try {
      setStatus(AppStatus.LOADING);
      const response = await fetch(url);
      if (!response.ok) throw new Error('Kon spreadsheet niet laden. Controleer of de link klopt en is gedeeld als CSV.');
      const text = await response.text();
      const parsed = parseCSV(text);
      if (parsed.length === 0) throw new Error('Geen geldige contacten gevonden. Zorg dat de kolommen Relatie, Contactpersoon, Onderwerp en Nummer gevuld zijn.');
      setContacts(parsed);
      setStatus(AppStatus.IDLE);
    } catch (err: any) {
      setErrorMessage(err.message);
      setStatus(AppStatus.ERROR);
    }
  }, []);

  useEffect(() => {
    loadCSV(csvUrl);
  }, [loadCSV, csvUrl]);

  const saveSettings = (newUrl: string) => {
    localStorage.setItem('csv_url', newUrl);
    setCsvUrl(newUrl);
    setShowSettings(false);
  };

  const handleStart = async () => {
    if (contacts.length === 0) return;
    const current = contacts[currentIndex];
    
    try {
      setStatus(AppStatus.READING);

      const speakText = `Je belt nu met relatie ${current.relatie}. De contactpersoon is ${current.contactpersoon}. Het onderwerp is ${current.onderwerp}.`;

      const audioData = await generateSpeech(speakText);
      if (!audioData) throw new Error('Spraak genereren mislukt');

      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      const ctx = audioContextRef.current;
      const buffer = await decodeAudioToBuffer(audioData, ctx);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      
      source.onended = () => {
        initiateCall(current.telefoonnummer);
      };

      source.start(0);

    } catch (err: any) {
      console.error(err);
      setErrorMessage('Fout bij voorlezen. Controleer je internetverbinding.');
      setStatus(AppStatus.ERROR);
    }
  };

  const initiateCall = (phone: string) => {
    setStatus(AppStatus.DIALING);
    const cleanPhone = phone.replace(/[^\d+]/g, '');
    window.location.href = `tel:${cleanPhone}`;
    
    // Auto increment index for next time
    setTimeout(() => {
      setCurrentIndex((prev) => (prev + 1) % contacts.length);
      setStatus(AppStatus.IDLE);
    }, 3000);
  };

  if (showSettings) {
    return (
      <div className="min-h-screen bg-white p-6 flex flex-col items-center">
        <header className="w-full max-w-md flex items-center justify-between mb-8">
          <button onClick={() => setShowSettings(false)} className="text-blue-600 font-bold flex items-center gap-2">
             <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
             Terug
          </button>
          <h2 className="text-xl font-black">Instellingen</h2>
          <div className="w-12"></div>
        </header>
        
        <div className="w-full max-w-md bg-slate-50 p-6 rounded-3xl">
          <label className="block text-slate-500 font-bold text-xs uppercase mb-2">Google Sheets CSV Link</label>
          <textarea 
            className="w-full p-4 rounded-2xl border-2 border-slate-200 focus:border-blue-500 outline-none text-sm font-mono h-32 mb-6"
            defaultValue={csvUrl}
            id="csv_input"
            placeholder="Plak hier de 'Gepubliceerd naar web' CSV link..."
          />
          <button 
            onClick={() => {
              const val = (document.getElementById('csv_input') as HTMLTextAreaElement).value;
              saveSettings(val);
            }}
            className="w-full py-4 bg-blue-600 text-white font-black rounded-2xl shadow-xl shadow-blue-100 active:scale-95 transition-transform"
          >
            OPSLAAN
          </button>
          <p className="mt-4 text-[10px] text-slate-400 leading-relaxed text-center">
            Zorg dat je spreadsheet is gedeeld via Bestand > Delen > Publiceren op internet. Kies 'Door komma's gescheiden waarden (.csv)'.
          </p>
        </div>
      </div>
    );
  }

  const currentContact = contacts[currentIndex];

  return (
    <div className="min-h-screen flex flex-col bg-white overflow-hidden select-none">
      {/* Settings Gear Icon Button */}
      <button 
        onClick={() => setShowSettings(true)}
        className="fixed top-6 right-6 p-4 text-slate-300 hover:text-blue-600 transition-colors z-20"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>

      <main className="flex-1 flex flex-col items-center justify-center p-6 gap-12">
        {status === AppStatus.LOADING && (
          <div className="flex flex-col items-center gap-4">
            <div className="w-16 h-16 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
            <p className="font-black text-slate-400 text-sm tracking-widest uppercase">Laden...</p>
          </div>
        )}

        {status === AppStatus.ERROR && (
          <div className="text-center max-w-xs">
            <div className="text-red-500 mb-6 flex justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <p className="text-slate-800 font-bold mb-8 leading-tight">{errorMessage}</p>
            <button 
              onClick={() => loadCSV(csvUrl)}
              className="px-8 py-3 bg-slate-900 text-white rounded-full font-black text-xs uppercase tracking-widest shadow-xl shadow-slate-200"
            >
              OPNIEUW
            </button>
          </div>
        )}

        {(status === AppStatus.IDLE || status === AppStatus.READING || status === AppStatus.DIALING) && currentContact && (
          <div className="flex flex-col items-center gap-12 w-full animate-in fade-in zoom-in duration-500">
            
            {/* The Huge Blue Start Button */}
            <button
              disabled={status !== AppStatus.IDLE}
              onClick={handleStart}
              className={`
                w-72 h-72 rounded-full flex items-center justify-center transition-all shadow-blue-200 shadow-[0_30px_60px_-12px_rgba(37,99,235,0.45)] active:scale-90 relative
                ${status === AppStatus.IDLE ? 'bg-blue-600' : 'bg-slate-100 cursor-not-allowed'}
              `}
            >
              {status === AppStatus.READING ? (
                <div className="flex gap-2 items-center">
                  <div className="w-3 h-12 bg-blue-600 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                  <div className="w-3 h-16 bg-blue-600 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                  <div className="w-3 h-12 bg-blue-600 rounded-full animate-bounce"></div>
                </div>
              ) : status === AppStatus.DIALING ? (
                <svg className="text-green-500 animate-pulse" xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 24 24" fill="currentColor"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
              ) : (
                <span className="text-white text-5xl font-black uppercase tracking-[0.2em] -mr-1">
                  START
                </span>
              )}
            </button>

            {/* Display Contact Person Name - Prominent as requested */}
            <div className="text-center px-4 max-w-sm">
              <p className="text-xs text-slate-400 uppercase tracking-widest mb-3 font-black">Contactpersoon</p>
              <h2 className="text-5xl font-black text-slate-900 tracking-tight leading-none break-words">
                {currentContact.contactpersoon}
              </h2>
            </div>

            {/* Pagination / List Navigation */}
            <div className="fixed bottom-12 flex gap-8 items-center bg-slate-50 p-2 rounded-full border border-slate-100 shadow-sm">
              <button 
                onClick={() => setCurrentIndex((prev) => (prev - 1 + contacts.length) % contacts.length)}
                className="w-12 h-12 flex items-center justify-center bg-white rounded-full shadow-md text-slate-400 active:bg-slate-50 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <span className="text-slate-800 font-black text-sm tabular-nums">
                {currentIndex + 1} / {contacts.length}
              </span>
              <button 
                onClick={() => setCurrentIndex((prev) => (prev + 1) % contacts.length)}
                className="w-12 h-12 flex items-center justify-center bg-white rounded-full shadow-md text-slate-400 active:bg-slate-50 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Status Overlay for iPhone/Handheld feel */}
      {(status === AppStatus.READING || status === AppStatus.DIALING) && (
        <div className="fixed bottom-24 left-0 right-0 flex justify-center pointer-events-none">
           <div className="bg-slate-900/90 backdrop-blur-md px-6 py-3 rounded-full shadow-2xl animate-bounce">
              <span className="text-white text-xs font-black uppercase tracking-widest">
                {status === AppStatus.READING ? 'Informatie wordt voorgelezen...' : 'Telefoon wordt geopend...'}
              </span>
           </div>
        </div>
      )}
    </div>
  );
};

export default App;
