async function test() {
  const loginRes = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin.val_1785967730381@mindease.com',
      password: 'adminPassword123'
    })
  });
  const loginData: any = await loginRes.json();
  const token = loginData.data.token;

  // Get Jonh dow dossier
  const res = await fetch('http://localhost:3000/api/admin/psychologist-applications/179f6c85-57ec-412d-bb4b-f94b823de9c4', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data: any = await res.json();
  const docs = data.data.request.psychologist.documents;
  console.log(`Found ${docs.length} documents for Jonh dow:`);

  for (const doc of docs) {
    console.log(`\nTesting download for document: ${doc.originalFilename} (ID: ${doc.id})`);
    const dlRes = await fetch(`http://localhost:3000/api/admin/documents/${doc.id}/download`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('Download HTTP status:', dlRes.status);
    console.log('Content-Type header:', dlRes.headers.get('content-type'));
    const buffer = await dlRes.arrayBuffer();
    console.log('Downloaded bytes length:', buffer.byteLength);
  }
}

test().catch(console.error);
