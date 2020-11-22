import Weiwu from '../../src/weiwu';

async function run() {
    await Weiwu.registerSW('./sw.js', {scope: './'});

    const map1 = await Weiwu.registerMap('piyo', {
        type: 'xyz',
        width: 255,
        height: 1024,
        url: 'http://hoge.com/hoge/hoge'
    });
    console.log(map1);
    const map2 = await Weiwu.registerMap('hoge', {
        type: 'wmts',
        minLat: 35.0,
        maxLat: 35.1,
        minLng: 135.0,
        maxLng: 135.1,
        minZoom: 17,
        maxZoom: 18,
        url: 'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png'
    });
    console.log(map2);
    const map3 = await Weiwu.registerMap('fuga', {
        type: 'wmts',
        minZoom: 17,
        maxZoom: 18,
        url: 'http://hoge.com/hoge/hoge'
    });
    console.log(map3);
    await map3.remove();

    await map2.clean();
    map2.addEventListener('proceed', (e) => {
        console.log(e);
    });
    map2.addEventListener('finish', (e) => {
        console.log(e);
    });
    map2.addEventListener('stop', (e) => {
        console.log(e);
    });
    await map2.fetchAll();

    const stats = await map2.stats();
    console.log(stats);
}

run();