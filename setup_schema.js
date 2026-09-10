import fs from 'fs';
import path from 'path';

async function setupSchema() {
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
  
  const loginData = await loginRes.json();
  const token = loginData.data.access_token;
  console.log('✅ Logged in successfully');

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  async function createCollection(collectionName, fields) {
    const res = await fetch(`${BASE_URL}/collections`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        collection: collectionName,
        meta: { icon: 'box', note: `Collection for ${collectionName}` },
        schema: { name: collectionName },
        fields: fields
      })
    });
    
    if (!res.ok) {
      console.error(`Failed to create collection ${collectionName}:`, await res.text());
    } else {
      console.log(`✅ Created collection: ${collectionName}`);
    }
  }

  async function createRelation(collection, field, related_collection) {
    const res = await fetch(`${BASE_URL}/relations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        collection,
        field,
        related_collection,
        meta: {
            many_collection: collection,
            many_field: field,
            one_collection: related_collection
        }
      })
    });
    if (!res.ok) {
      console.error(`Failed to create relation ${collection}.${field} -> ${related_collection}:`, await res.text());
    } else {
      console.log(`✅ Created relation: ${collection}.${field} -> ${related_collection}`);
    }
  }

  const defaultFields = [
    {
      field: 'id',
      type: 'uuid',
      meta: { hidden: true, readonly: true, interface: 'input' },
      schema: { is_primary_key: true, has_auto_increment: false }
    },
    {
      field: 'status',
      type: 'string',
      meta: {
        interface: 'select-dropdown',
        options: {
          choices: [
            { text: 'Published', value: 'published' },
            { text: 'Draft', value: 'draft' },
            { text: 'Archived', value: 'archived' }
          ]
        }
      },
      schema: { default_value: 'published' }
    },
    {
      field: 'date_created',
      type: 'timestamp',
      meta: { special: ['date-created'], interface: 'datetime', readonly: true, hidden: true },
      schema: {}
    },
    {
      field: 'date_updated',
      type: 'timestamp',
      meta: { special: ['date-updated'], interface: 'datetime', readonly: true, hidden: true },
      schema: {}
    }
  ];

  // 4. listening_attempts
  await fetch(`${BASE_URL}/collections/listening_attempts`, { method: 'DELETE', headers }).catch(() => {});
  await createCollection('listening_attempts', [
    { field: 'id', type: 'uuid', meta: { hidden: true, readonly: true, interface: 'input' }, schema: { is_primary_key: true, has_auto_increment: false } },
    { field: 'user_id', type: 'uuid', meta: { interface: 'select-dropdown-m2o' }, schema: {} },
    { field: 'clip_id', type: 'uuid', meta: { interface: 'select-dropdown-m2o' }, schema: {} },
    { field: 'answer', type: 'string', meta: { interface: 'input' }, schema: {} },
    { field: 'is_correct', type: 'boolean', meta: { interface: 'boolean' }, schema: {} },
    { field: 'attempt_number', type: 'integer', meta: { interface: 'input' }, schema: {} },
    { field: 'listen_count', type: 'integer', meta: { interface: 'input' }, schema: {} },
    { field: 'date_created', type: 'timestamp', meta: { special: ['date-created'], interface: 'datetime', readonly: true, hidden: true }, schema: {} }
  ]);

  // 5. Create relations
  await createRelation('listening_attempts', 'user_id', 'directus_users');
  await createRelation('listening_attempts', 'clip_id', 'listening_clips');

  console.log('✅ Done setting up schema!');
}

setupSchema().catch(console.error);
