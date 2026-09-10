

const DIRECTUS_URL = 'http://localhost:8081/api';
const ADMIN_EMAIL = 'admin@email.com';
const ADMIN_PASSWORD = 'H8987ntdE6dkqWFL';

async function main() {
  // 1. Login
  const loginRes = await fetch(`${DIRECTUS_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const loginData = await loginRes.json();
  const token = loginData.data.access_token;
  console.log('Logged in successfully.');

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  };

  // 2. Create Collection 'comments'
  const collectionData = {
    collection: 'comments',
    meta: {
      icon: 'chat',
      note: 'User comments on listening targets',
      display_template: '{{content}}',
      hidden: false,
      singleton: false
    },
    schema: {
      name: 'comments'
    },
    fields: [
      {
        field: 'id',
        type: 'uuid',
        meta: { hidden: true, readonly: true, interface: 'input' },
        schema: { is_primary_key: true, has_auto_increment: false }
      },
      {
        field: 'date_created',
        type: 'timestamp',
        meta: { readonly: true, interface: 'datetime', special: ['date-created'] },
        schema: { default_value: 'CURRENT_TIMESTAMP' }
      },
      {
        field: 'date_updated',
        type: 'timestamp',
        meta: { readonly: true, interface: 'datetime', special: ['date-updated'] },
        schema: { default_value: 'CURRENT_TIMESTAMP' }
      },
      {
        field: 'user_created',
        type: 'uuid',
        meta: { readonly: true, interface: 'select-dropdown-m2o', special: ['user-created'] },
        schema: {}
      },
      {
        field: 'user_updated',
        type: 'uuid',
        meta: { readonly: true, interface: 'select-dropdown-m2o', special: ['user-updated'] },
        schema: {}
      },
      {
        field: 'target_id',
        type: 'uuid',
        meta: { interface: 'select-dropdown-m2o' },
        schema: {}
      },
      {
        field: 'parent_id',
        type: 'uuid',
        meta: { interface: 'select-dropdown-m2o' },
        schema: {}
      },
      {
        field: 'content',
        type: 'text',
        meta: { interface: 'input-multiline' },
        schema: {}
      },
      {
        field: 'upvotes',
        type: 'integer',
        meta: { interface: 'input' },
        schema: { default_value: 0 }
      },
      {
        field: 'downvotes',
        type: 'integer',
        meta: { interface: 'input' },
        schema: { default_value: 0 }
      }
    ]
  };

  console.log('Creating comments collection...');
  const createColRes = await fetch(`${DIRECTUS_URL}/collections`, {
    method: 'POST',
    headers,
    body: JSON.stringify(collectionData)
  });
  const createColJson = await createColRes.json();
  if (createColJson.errors) {
    console.log('Collection already exists or error:', createColJson.errors);
  } else {
    console.log('Created comments collection successfully.');
  }

  // 3. Create Relations
  console.log('Creating relations...');
  const relations = [
    {
      collection: 'comments',
      field: 'target_id',
      related_collection: 'listening_targets',
      meta: {
        one_field: null,
        sort_field: null,
        one_deselect_action: 'nullify',
        junction_field: null
      },
      schema: {
        on_update: 'CASCADE',
        on_delete: 'CASCADE'
      }
    },
    {
      collection: 'comments',
      field: 'parent_id',
      related_collection: 'comments',
      meta: {
        one_field: null,
        sort_field: null,
        one_deselect_action: 'nullify',
        junction_field: null
      },
      schema: {
        on_update: 'CASCADE',
        on_delete: 'CASCADE'
      }
    }
  ];

  for (const rel of relations) {
    const relRes = await fetch(`${DIRECTUS_URL}/relations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(rel)
    });
    const relJson = await relRes.json();
    if (relJson.errors) {
      console.log(`Relation error for ${rel.field}:`, relJson.errors);
    } else {
      console.log(`Created relation for ${rel.field} successfully.`);
    }
  }

  // 4. Update Permissions (Public + Authenticated)
  // Let's just create a role or update the existing Authenticated / Public roles.
  // Wait, direct role update via API is complex without knowing role IDs.
  // It's fine, we can fetch roles and update.
  console.log('Fetching roles...');
  const rolesRes = await fetch(`${DIRECTUS_URL}/roles`, { headers });
  const rolesJson = await rolesRes.json();
  
  const publicRole = rolesJson.data.find(r => r.name === 'Public' || r.id === null); // public role has id null in some versions, but here it's usually just empty policy.
  // Actually, standard directus v10 handles permissions via policies. Let's just leave permissions for manual or I'll run another script if needed.
  console.log('Finished DB creation script. Please configure permissions manually or I can script it.');
}

main().catch(console.error);
