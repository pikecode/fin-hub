def test_category_two_levels_and_move_parent_protection(client):
    root = client.post('/api/categories', json={'name': '层级测试一级'}).json()['data']['id']
    child = client.post('/api/categories', json={'name': '层级测试二级', 'parent_id': root}).json()['data']['id']
    assert client.post('/api/categories', json={'name': '不允许三级', 'parent_id': child}).status_code == 409
    other = client.post('/api/categories', json={'name': '另一个一级'}).json()['data']['id']
    assert client.patch('/api/categories/' + root, json={'parent_id': other}).status_code == 409
    assert client.patch('/api/categories/' + other, json={'parent_id': child}).status_code == 409
    assert client.patch('/api/categories/' + child, json={'parent_id': other}).status_code == 200
