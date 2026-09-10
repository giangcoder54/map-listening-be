import fs from 'fs';

async function setupTranslations() {
  const BASE_URL = 'http://127.0.0.1:8081/api';
  
  // Login to get token
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@email.com',
      password: 'H8987ntdE6dkqWFL'
    })
  });
  
  if (!loginRes.ok) {
    console.error('Failed to login:', await loginRes.text());
    process.exit(1);
  }
  
  const token = (await loginRes.json()).data.access_token;
  console.log('✅ Logged in successfully');

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  async function req(method, endpoint, body) {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`❌ ${method} ${endpoint} failed:`, text);
      return false;
    }
    console.log(`✅ ${method} ${endpoint} success`);
    return true;
  }

  // 1. Create languages collection
  await req('POST', '/collections', {
    collection: 'languages',
    meta: { icon: 'translate', note: 'System Languages' },
    schema: { name: 'languages' },
    fields: [
      {
        field: 'code',
        type: 'string',
        meta: { interface: 'input' },
        schema: { is_primary_key: true, has_auto_increment: false, max_length: 255 }
      },
      {
        field: 'name',
        type: 'string',
        meta: { interface: 'input' },
        schema: {}
      }
    ]
  });

  // 1.1 Insert default languages
  await req('POST', '/items/languages', [
    { code: 'vi-VN', name: 'Tiếng Việt' },
    { code: 'en-US', name: 'English' }
  ]);

  // 2. Create listening_targets_translations collection
  await req('POST', '/collections', {
    collection: 'listening_targets_translations',
    meta: { icon: 'translate', hidden: true },
    schema: { name: 'listening_targets_translations' },
    fields: [
      {
        field: 'id',
        type: 'uuid',
        meta: { hidden: true, readonly: true, interface: 'input' },
        schema: { is_primary_key: true, has_auto_increment: false }
      },
      {
        field: 'listening_targets_id',
        type: 'uuid',
        meta: { hidden: true },
        schema: {}
      },
      {
        field: 'languages_code',
        type: 'string',
        meta: { hidden: true },
        schema: {}
      },
      {
        field: 'explanation',
        type: 'text',
        meta: { interface: 'input-rich-text-html' },
        schema: {}
      },
      {
        field: 'tips',
        type: 'text',
        meta: { interface: 'input-rich-text-html' },
        schema: {}
      }
    ]
  });

  // 3. Delete old fields from listening_targets
  await req('DELETE', '/fields/listening_targets/explanation');
  await req('DELETE', '/fields/listening_targets/tips');

  // 4. Add alias field "translations" to listening_targets
  await req('POST', '/fields/listening_targets', {
    field: 'translations',
    type: 'alias',
    meta: {
      interface: 'translations',
      special: ['translations']
    },
    schema: null
  });

  // 5. Create Relations
  // 5.1 Relation for listening_targets_id
  await req('POST', '/relations', {
    collection: 'listening_targets_translations',
    field: 'listening_targets_id',
    related_collection: 'listening_targets',
    meta: {
      one_field: 'translations',
      junction_field: 'languages_code'
    }
  });

  // 5.2 Relation for languages_code
  await req('POST', '/relations', {
    collection: 'listening_targets_translations',
    field: 'languages_code',
    related_collection: 'languages',
    meta: {
      many_collection: 'listening_targets_translations',
      many_field: 'languages_code',
      one_collection: 'languages'
    }
  });

  // 6. Create listening_clips_translations collection
  await req('POST', '/collections', {
    collection: 'listening_clips_translations',
    meta: { icon: 'translate', hidden: true },
    schema: { name: 'listening_clips_translations' },
    fields: [
      {
        field: 'id',
        type: 'uuid',
        meta: { hidden: true, readonly: true, interface: 'input' },
        schema: { is_primary_key: true, has_auto_increment: false }
      },
      {
        field: 'listening_clips_id',
        type: 'uuid',
        meta: { hidden: true },
        schema: {}
      },
      {
        field: 'languages_code',
        type: 'string',
        meta: { hidden: true },
        schema: {}
      },
      {
        field: 'context_translation',
        type: 'text',
        meta: { interface: 'input-multiline', note: 'Dịch nghĩa của câu thoại sang ngôn ngữ này' },
        schema: {}
      }
    ]
  });

  // 7. Add alias field "translations" to listening_clips
  await req('POST', '/fields/listening_clips', {
    field: 'translations',
    type: 'alias',
    meta: {
      interface: 'translations',
      special: ['translations']
    },
    schema: null
  });

  // 8. Create Relations for listening_clips
  // 8.1 Relation for listening_clips_id
  await req('POST', '/relations', {
    collection: 'listening_clips_translations',
    field: 'listening_clips_id',
    related_collection: 'listening_clips',
    meta: {
      one_field: 'translations',
      junction_field: 'languages_code'
    }
  });

  // 8.2 Relation for languages_code (listening_clips_translations)
  await req('POST', '/relations', {
    collection: 'listening_clips_translations',
    field: 'languages_code',
    related_collection: 'languages',
    meta: {
      many_collection: 'listening_clips_translations',
      many_field: 'languages_code',
      one_collection: 'languages'
    }
  });

  console.log('✅ Done setting up translations!');
}

setupTranslations().catch(console.error);
