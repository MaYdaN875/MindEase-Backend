async function test() {
  // Login as admin
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

  // Test getApplication with psychologistProfile ID: 179f6c85-57ec-412d-bb4b-f94b823de9c4
  const profileId = '179f6c85-57ec-412d-bb4b-f94b823de9c4';
  const res = await fetch(`http://localhost:3000/api/admin/psychologist-applications/${profileId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data: any = await res.json();
  console.log('Get application by profile ID status:', res.status);
  console.log('Psychologist name:', data.data?.request?.psychologist?.user?.name);
  console.log('Documents count:', data.data?.request?.psychologist?.documents?.length);
}

test().catch(console.error);
