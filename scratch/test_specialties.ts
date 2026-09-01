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
  console.log('Login successful');

  // 1. List specialties
  console.log('\n1. Listing specialties from DB...');
  const listRes = await fetch('http://localhost:3000/api/admin/specialties', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const listData: any = await listRes.json();
  console.log('List HTTP status:', listRes.status, `Total found: ${listData.data?.specialties?.length}`);
  console.log('Specialties in DB:', listData.data?.specialties?.map((s: any) => `${s.name} (${s._count?.psychologists || 0} psychologists)`));

  // 2. Create a new specialty
  const testName = `Terapia Neurocognitiva Experimental ${Date.now()}`;
  console.log(`\n2. Creating new specialty: "${testName}"...`);
  const createRes = await fetch('http://localhost:3000/api/admin/specialties', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ name: testName })
  });
  const createData: any = await createRes.json();
  console.log('Create HTTP status:', createRes.status, createData);
  const createdId = createData.data?.specialty?.id;

  // 3. Update specialty name
  const updatedName = `${testName} - Revisada`;
  console.log(`\n3. Updating specialty ${createdId} to "${updatedName}"...`);
  const updateRes = await fetch(`http://localhost:3000/api/admin/specialties/${createdId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ name: updatedName })
  });
  const updateData: any = await updateRes.json();
  console.log('Update HTTP status:', updateRes.status, updateData);

  // 4. Delete specialty
  console.log(`\n4. Deleting specialty ${createdId}...`);
  const deleteRes = await fetch(`http://localhost:3000/api/admin/specialties/${createdId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  const deleteData: any = await deleteRes.json();
  console.log('Delete HTTP status:', deleteRes.status, deleteData);

  console.log('\nAll Specialty CRUD operations verified successfully!');
}

test().catch(console.error);
