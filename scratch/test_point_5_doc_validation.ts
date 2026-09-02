async function testDocValidation() {
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

  // List users to find a psychologist with documents
  const usersRes = await fetch('http://localhost:3000/api/admin/users', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const usersData: any = await usersRes.json();
  const psychUser = usersData.data.users.find((u: any) => u.psychologistProfile?.documents?.length > 0);
  const profileId = psychUser.psychologistProfile.id;

  // Get full dossier
  const dossierRes = await fetch(`http://localhost:3000/api/admin/psychologist-applications/${profileId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const dossierData: any = await dossierRes.json();
  const request = dossierData.data.request;
  const docs = request.psychologist ? request.psychologist.documents : request.documents;
  console.log(`Documents count: ${docs?.length}`);

  if (docs && docs.length > 0) {
    const docToTest = docs[0];
    console.log(`Testing document: ${docToTest.id} (${docToTest.documentType})`);

    // 1. Approve document with expiration date
    const expDate = '2028-12-31T00:00:00.000Z';
    const updateRes = await fetch(`http://localhost:3000/api/admin/documents/${docToTest.id}/status`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        status: 'APPROVED',
        expiresAt: expDate
      })
    });
    const updateData: any = await updateRes.json();
    console.log('Approve doc status:', updateRes.status, updateData.message);
    console.log('Updated doc:', updateData.data.document.status, updateData.data.document.expiresAt);

    // 2. Reject document
    const rejectRes = await fetch(`http://localhost:3000/api/admin/documents/${docToTest.id}/status`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        status: 'REJECTED'
      })
    });
    const rejectData: any = await rejectRes.json();
    console.log('Reject doc status:', rejectRes.status, rejectData.message);

    // 3. Reset back to APPROVED
    await fetch(`http://localhost:3000/api/admin/documents/${docToTest.id}/status`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        status: 'APPROVED',
        expiresAt: expDate
      })
    });
    console.log('Reset back to APPROVED complete.');
  }
}

testDocValidation().catch(console.error);
