export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    try {
      const payload = await request.json();
      console.log("📥 Payload recibido:", JSON.stringify(payload));
      
      // === MANEJO DE INLINE QUERIES ===
      if (payload.inline_query) {
        return await this.handleInlineQuery(payload.inline_query, env);
      }

      // === MANEJO DE MENSAJES NORMALES ===
      if (!payload.message || !payload.message.text) {
        console.log("⚠️ Mensaje sin texto, ignorando");
        return new Response("OK", { status: 200 });
      }

      const chatId = payload.message.chat.id;
      const userText = payload.message.text;
      const userName = payload.message.from.username || payload.message.from.first_name || "Unknown";
      const userId = payload.message.from.id;
      
      console.log(`👤 Usuario: @${userName} (${userId})`);
      console.log(`💬 Mensaje: ${userText}`);

      const isAdmin = env.ADMIN_CHAT_ID && userId.toString() === env.ADMIN_CHAT_ID.toString();

      // === COMANDO DE GENERACIÓN DE IMÁGENES ===
      if (userText.startsWith('/image ')) {
        return await this.handleImageGeneration(userText.substring(7), chatId, userName, userId, isAdmin, env);
      }

      // === COMANDOS DE ADMIN ===
      if (isAdmin && userText.startsWith('/')) {
        const parts = userText.split(' ');
        const command = parts[0];
        
        if (command === '/block' && parts[1]) {
          const targetUserId = parts[1];
          let blockedUsers = [];
          
          if (env.CHAT_HISTORY) {
            const stored = await env.CHAT_HISTORY.get('blocked_users');
            if (stored) blockedUsers = JSON.parse(stored);
          }
          
          if (!blockedUsers.includes(targetUserId)) {
            blockedUsers.push(targetUserId);
            await env.CHAT_HISTORY.put('blocked_users', JSON.stringify(blockedUsers));
          }
          
          await this.sendMessage(env, chatId, `✅ Usuario ${targetUserId} bloqueado.`);
          return new Response("OK");
        }
        
        if (command === '/unblock' && parts[1]) {
          const targetUserId = parts[1];
          let blockedUsers = [];
          
          if (env.CHAT_HISTORY) {
            const stored = await env.CHAT_HISTORY.get('blocked_users');
            if (stored) blockedUsers = JSON.parse(stored);
          }
          
          blockedUsers = blockedUsers.filter(id => id !== targetUserId);
          await env.CHAT_HISTORY.put('blocked_users', JSON.stringify(blockedUsers));
          
          await this.sendMessage(env, chatId, `✅ Usuario ${targetUserId} desbloqueado.`);
          return new Response("OK");
        }
        
        if (command === '/setPassword' && parts[1]) {
          const password = parts.slice(1).join(' ');
          await env.CHAT_HISTORY.put('global_password', password);
          
          await this.sendMessage(env, chatId, `🔐 Contraseña establecida.\n\nLos usuarios deberán enviar la contraseña para usar el bot.`);
          return new Response("OK");
        }
        
        if (command === '/unsetPassword') {
          await env.CHAT_HISTORY.delete('global_password');
          await env.CHAT_HISTORY.delete('verified_users');
          
          await this.sendMessage(env, chatId, `✅ Contraseña eliminada. El bot es público de nuevo.`);
          return new Response("OK");
        }
      }

      // === VERIFICAR SI EL USUARIO ESTÁ BLOQUEADO ===
      if (env.CHAT_HISTORY) {
        const blockedUsersData = await env.CHAT_HISTORY.get('blocked_users');
        if (blockedUsersData) {
          const blockedUsers = JSON.parse(blockedUsersData);
          if (blockedUsers.includes(userId.toString())) {
            console.log(`🚫 Usuario ${userId} está bloqueado`);
            return new Response("OK");
          }
        }
      }

      // === VERIFICAR CONTRASEÑA (solo si no es admin) ===
      if (!isAdmin && env.CHAT_HISTORY) {
        const globalPassword = await env.CHAT_HISTORY.get('global_password');
        
        if (globalPassword) {
          let verifiedUsers = [];
          const verifiedData = await env.CHAT_HISTORY.get('verified_users');
          if (verifiedData) verifiedUsers = JSON.parse(verifiedData);
          
          if (!verifiedUsers.includes(userId.toString())) {
            if (userText.trim() === globalPassword) {
              verifiedUsers.push(userId.toString());
              await env.CHAT_HISTORY.put('verified_users', JSON.stringify(verifiedUsers));
              
              await this.sendMessage(env, chatId, `✅ Contraseña correcta. Ahora puedes usar el bot.`);
              return new Response("OK");
            } else {
              await this.sendMessage(env, chatId, `🔐 Por favor, envía la contraseña para usar el bot.`);
              return new Response("OK");
            }
          }
        }
      }

      // === PROCESAMIENTO NORMAL DEL MENSAJE ===
      const historyKey = `chat_${chatId}`;
      let history = [];
      
      if (env.CHAT_HISTORY) {
        const storedHistory = await env.CHAT_HISTORY.get(historyKey);
        if (storedHistory) {
          history = JSON.parse(storedHistory);
        }
      }

      history.push({
        role: "user",
        content: userText
      });

      let totalChars = JSON.stringify(history).length;
      while (totalChars > 4000 && history.length > 1) {
        history.shift();
        totalChars = JSON.stringify(history).length;
      }

      console.log(`📚 Historial: ${history.length} mensajes, ${totalChars} caracteres`);
      
      const fullResponse = await this.callOllama(env, history);
      
      console.log(`✅ Respuesta generada (${fullResponse.length} caracteres)`);

      history.push({
        role: "assistant",
        content: fullResponse
      });

      if (env.CHAT_HISTORY) {
        await env.CHAT_HISTORY.put(historyKey, JSON.stringify(history), {
          expirationTtl: 86400
        });
      }

      console.log("📤 Enviando respuesta a Telegram...");
      
      try {
        await this.sendMessage(env, chatId, fullResponse || "No recibí respuesta del modelo.");
        console.log("✅ Mensaje enviado al usuario");
      } catch (err) {
        console.error("❌ Error enviando mensaje HTML:", err.message);
        console.error("Primeros 300 caracteres:", fullResponse.substring(0, 300));
        
        // Fallback: limpiar HTML y enviar como texto plano
        const plainText = fullResponse
          .replace(/<b>/g, '*').replace(/<\/b>/g, '*')
          .replace(/<i>/g, '_').replace(/<\/i>/g, '_')
          .replace(/<code>/g, '`').replace(/<\/code>/g, '`')
          .replace(/<pre><code class="language-\w+">/g, '```\n').replace(/<\/code><\/pre>/g, '\n```')
          .replace(/<pre>/g, '```\n').replace(/<\/pre>/g, '\n```')
          .replace(/<br\s*\/?>/g, '\n')
          .replace(/<[^>]+>/g, ''); // Eliminar resto de etiquetas
        
        console.log("📝 Enviando versión simplificada");
        await this.sendMessagePlain(env, chatId, plainText);
      }

      // LOGGING al admin
      try {
        if (env.ADMIN_CHAT_ID && !isAdmin) {
          console.log("📊 Enviando log al admin...");
          const logMessage = `📊 <b>Nueva conversación</b>\n\n` +
            `👤 Usuario: @${userName} (ID: ${userId})\n` +
            `💬 Chat ID: ${chatId}\n\n` +
            `❓ <b>Pregunta:</b>\n${this.escapeHtml(userText)}\n\n` +
            `✅ <b>Respuesta:</b>\n${this.escapeHtml(fullResponse)}`;

          await this.sendMessage(env, env.ADMIN_CHAT_ID, logMessage);
          console.log("✅ Log enviado al admin");
        }
      } catch (err) {
        console.error("❌ Error enviando log:", err);
      }

    } catch (error) {
      console.error("❌ ERROR GENERAL:", error);
      console.error("Stack:", error.stack);
    }

    return new Response("OK", { status: 200 });
  },

  // === GENERACIÓN DE IMÁGENES ===
  async handleImageGeneration(inputText, chatId, userName, userId, isAdmin, env) {
    console.log("🎨 Generación de imagen solicitada");
    
    // Parsear resolución y prompt
    const { width, height, prompt } = this.parseImageCommand(inputText);
    
    if (!prompt.trim()) {
      await this.sendMessage(env, chatId, "❌ Debes especificar un prompt.\n\nEjemplo: <code>/image 1024x768 a cat astronaut</code>");
      return new Response("OK");
    }
    
    console.log(`📐 Resolución: ${width}x${height}`);
    console.log(`✏️ Prompt: ${prompt}`);
    
    // Generar imagen con Pollinations
    const imageUrl = await this.generateImageUrl(prompt, width, height);
    
    console.log("📤 Enviando imagen al usuario...");
    await this.sendPhoto(env, chatId, imageUrl, `🎨 <b>${prompt}</b>\n\n${width}x${height}`);
    
    // Log al admin
    try {
      if (env.ADMIN_CHAT_ID && !isAdmin) {
        const logMessage = `🎨 <b>Generación de imagen</b>\n\n` +
          `👤 Usuario: @${userName} (ID: ${userId})\n` +
          `📐 Resolución: ${width}x${height}\n` +
          `✏️ Prompt: ${this.escapeHtml(prompt)}`;
        
        await this.sendMessage(env, env.ADMIN_CHAT_ID, logMessage);
      }
    } catch (err) {
      console.error("❌ Error enviando log de imagen:", err);
    }
    
    return new Response("OK");
  },

  // Parsear comando de imagen
  parseImageCommand(text) {
    // Detectar patrón: [WIDTHxHEIGHT] prompt
    const resolutionMatch = text.match(/^(\d+)[xX](\d+)\s+(.+)$/);
    
    if (resolutionMatch) {
      return {
        width: parseInt(resolutionMatch[1]),
        height: parseInt(resolutionMatch[2]),
        prompt: resolutionMatch[3].trim()
      };
    }
    
    // Sin resolución especificada, usar default
    return {
      width: 1024,
      height: 1024,
      prompt: text.trim()
    };
  },

  // Generar URL de Pollinations
  generateImageUrl(prompt, width, height) {
    const encodedPrompt = encodeURIComponent(prompt);
    return `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&model=flux&nologo=true`;
  },

  // === MANEJO DE INLINE QUERIES ===
  async handleInlineQuery(inlineQuery, env) {
    const queryId = inlineQuery.id;
    const userQuery = inlineQuery.query.trim();
    const userId = inlineQuery.from.id;
    const userName = inlineQuery.from.username || inlineQuery.from.first_name || "Unknown";
    
    console.log(`🔍 Inline query de ${userId}: "${userQuery}"`);

    // Si la query está vacía, mostrar placeholder
    if (!userQuery) {
      await this.answerInlineQuery(env, queryId, [{
        type: "article",
        id: "1",
        title: "Escribe tu pregunta o usa 'image' para generar imágenes",
        description: "Ejemplos: 'hola' o 'image a cat astronaut'",
        input_message_content: {
          message_text: "💡 Usa @smaicbot seguido de tu pregunta\n🎨 O usa: <code>@smaicbot image tu prompt aquí</code>",
          parse_mode: "HTML"
        }
      }]);
      return new Response("OK");
    }

    // Verificar si es comando de imagen
    const imageMatch = userQuery.match(/^(image|\/image)\s+(.+)$/i);
    
    if (imageMatch) {
      const imagePrompt = imageMatch[2];
      const { width, height, prompt } = this.parseImageCommand(imagePrompt);
      const imageUrl = this.generateImageUrl(prompt, width, height);
      
      await this.answerInlineQuery(env, queryId, [{
        type: "photo",
        id: "1",
        photo_url: imageUrl,
        thumbnail_url: imageUrl,
        title: `🎨 ${prompt}`,
        description: `${width}x${height}`,
        caption: `🎨 <b>${prompt}</b>\n\n${width}x${height}`,
        parse_mode: "HTML"
      }]);
      
      // Log al admin
      try {
        if (env.ADMIN_CHAT_ID) {
          const isAdmin = userId.toString() === env.ADMIN_CHAT_ID.toString();
          if (!isAdmin) {
            const logMessage = `🎨 <b>Inline - Generación de imagen</b>\n\n` +
              `👤 Usuario: @${userName} (ID: ${userId})\n` +
              `📐 Resolución: ${width}x${height}\n` +
              `✏️ Prompt: ${this.escapeHtml(prompt)}`;
            
            await this.sendMessage(env, env.ADMIN_CHAT_ID, logMessage);
          }
        }
      } catch (err) {
        console.error("❌ Error enviando log inline imagen:", err);
      }
      
      return new Response("OK");
    }

    // Verificar si el usuario está bloqueado
    if (env.CHAT_HISTORY) {
      const blockedUsersData = await env.CHAT_HISTORY.get('blocked_users');
      if (blockedUsersData) {
        const blockedUsers = JSON.parse(blockedUsersData);
        if (blockedUsers.includes(userId.toString())) {
          console.log(`🚫 Usuario ${userId} bloqueado en inline query`);
          await this.answerInlineQuery(env, queryId, [{
            type: "article",
            id: "1",
            title: "⛔ Acceso denegado",
            description: "No tienes permiso para usar este bot",
            input_message_content: {
              message_text: "⛔ No tienes permiso para usar este bot",
              parse_mode: "HTML"
            }
          }]);
          return new Response("OK");
        }
      }
    }

    try {
      // Llamar a Ollama (sin historial en inline queries)
      const history = [{
        role: "user",
        content: userQuery
      }];

      const response = await this.callOllama(env, history);

      await this.answerInlineQuery(env, queryId, [{
        type: "article",
        id: "1",
        title: "StringManolo AI",
        description: response.substring(0, 100) + (response.length > 100 ? "..." : ""),
        input_message_content: {
          message_text: response,
          parse_mode: "HTML"
        }
      }]);

      // LOGGING: Enviar inline query al admin
      try {
        if (env.ADMIN_CHAT_ID) {
          const isAdmin = userId.toString() === env.ADMIN_CHAT_ID.toString();
          if (!isAdmin) {
            console.log("📊 Enviando log inline al admin...");
            const logMessage = `🔍 <b>Inline Query</b>\n\n` +
              `👤 Usuario: @${userName} (ID: ${userId})\n\n` +
              `❓ <b>Pregunta:</b>\n${this.escapeHtml(userQuery)}\n\n` +
              `✅ <b>Respuesta:</b>\n${this.escapeHtml(response)}`;

            await this.sendMessage(env, env.ADMIN_CHAT_ID, logMessage);
            console.log("✅ Log inline enviado al admin");
          }
        }
      } catch (err) {
        console.error("❌ Error enviando log inline:", err);
      }

    } catch (error) {
      console.error("Error en inline query:", error);
      await this.answerInlineQuery(env, queryId, [{
        type: "article",
        id: "1",
        title: "❌ Error",
        description: "Hubo un error procesando tu consulta",
        input_message_content: {
          message_text: "❌ Error procesando la consulta. Intenta de nuevo.",
          parse_mode: "HTML"
        }
      }]);
    }

    return new Response("OK");
  },

  // Responder a inline query
  async answerInlineQuery(env, queryId, results) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/answerInlineQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inline_query_id: queryId,
        results: results,
        cache_time: 0
      })
    });
  },

  // Llamar a Ollama (función reutilizable)
  async callOllama(env, history) {
    console.log("🤖 Enviando request a la API...");
    
    const response = await fetch("https://ollama.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OLLAMA_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-oss:120b-cloud",
        messages: [
          {
            role: "system",
            content: `Eres StringManolo AI Chat Bot (@smaicbot), un asistente de IA en Telegram creado para ayudar a los usuarios con cualquier pregunta o tarea. Eres amigable, útil y conciso en tus respuestas.

CRÍTICO - PROHIBIDO USAR MARKDOWN:
❌ NO uses **, *, __, \`, \`\`\`, [ ], etc.
❌ NO uses markdown de ningún tipo
✅ SOLO usa las etiquetas HTML listadas abajo

FORMATO PERMITIDO (HTML únicamente):
<b>texto en negrita</b>
<i>texto en cursiva</i>
<code>código inline como npm install</code>

Para bloques de código SIEMPRE usa este formato EXACTO:
<pre>código
en
múltiples
líneas</pre>

O con lenguaje específico:
<pre><code class="language-javascript">código aquí</code></pre>

IMPORTANTE - CÓDIGO HTML/CSS/JS:
Cuando el código contiene <, > o &, debes escaparlos:
< se escribe como &lt;
> se escribe como &gt;
& se escribe como &amp;

Ejemplo CORRECTO de código Node.js:
<pre><code class="language-javascript">const express = require('express');
app.get('/', (req, res) =&gt; {
  res.send('&lt;h1&gt;Hola&lt;/h1&gt;');
});</code></pre>

Para listas usa saltos de línea, NO asteriscos:
❌ INCORRECTO: * Item 1
✅ CORRECTO: • Item 1

Recuerda: NUNCA uses markdown. Solo HTML.`
          },
          ...history
        ],
        stream: true
      }),
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }

    let fullResponse = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const jsonLine = line.replace(/^data: /, "").trim();
        if (!jsonLine || jsonLine === "[DONE]") continue;

        try {
          const json = JSON.parse(jsonLine);
          const delta = json.choices[0]?.delta;
          if (delta?.content) fullResponse += delta.content;
        } catch (e) {
          console.error("Parse error:", e);
        }
      }
    }

    return fullResponse;
  },

  // Enviar foto
  async sendPhoto(env, chatId, photoUrl, caption) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption: caption,
        parse_mode: "HTML"
      })
    });
  },

  // Enviar mensaje normal
  async sendMessage(env, chatId, text) {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: "HTML"
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Telegram API error: ${response.status} - ${error}`);
    }
  },

  // Enviar mensaje sin formato (fallback)
  async sendMessagePlain(env, chatId, text) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text
      })
    });
  },

  // Escapar HTML para logs
  escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
};
