const {
  BaseKonnector,
  requestFactory,
  saveFiles,
  log,
  errors,
  mkdirp
} = require('cozy-konnector-libs')
const request = requestFactory({
  // debug: true,
  cheerio: false,
  json: true,
  jar: true
})
const cheerio = require('cheerio')

let currentToken = null

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  const data = await authenticate(fields.login, fields.password, fields)
  log('info', 'Successfully logged in')

  if (data.accounts.length > 0) {
    log('warn', `There are ${data.accounts.length}, taking the main one`)
  }
  this.account = data.accounts.find(account => account.main)

  const { anneeScolaireCourante, nomEtablissement } = this.account

  fields.folderPath = `${fields.folderPath}/${nomEtablissement}`
  await mkdirp(fields.folderPath)

  const eleves = this.account.profile.eleves

  for (const eleve of eleves) {
    const eleveFolder = `${fields.folderPath}/${anneeScolaireCourante} - ${
      eleve.classe.libelle
    } (${eleve.prenom})`
    await mkdirp(eleveFolder)
    await fetchEleveRessources.bind(this)(eleve, eleveFolder)
  }
}

async function fetchEleveRessources(eleve, eleveFolder) {
  const classId = eleve.classe.id
  const {
    token,
    data: { matieres }
  } = await request.post(
    `https://api.ecoledirecte.com/v3/R/${classId}/viedelaclasse.awp?verbe=get&`,
    {
      form: {
        data: JSON.stringify({ token: currentToken })
      }
    }
  )

  this.currentToken = token
  // const Turndown = require('turndown')
  // log('info', JSON.stringify(Turndown, null, 2))
  // const turndown = new Turndown()

  for (const matiere of matieres) {
    const matiereFolder = `${eleveFolder}/${matiere.libelle}`
    await mkdirp(matiereFolder)
    const readme = cheerio
      .load(Buffer.from(matiere.contenu, 'base64').toString('utf8'))
      .text()
    // const readme = turndown.turndown(
    //   Buffer.from(matiere.contenu, 'base64').toString('utf8')
    // )
    await saveFiles(
      [{ filestream: readme, filename: 'Instructions.md' }],
      matiereFolder,
      {
        validateFile: () => true,
        shouldReplaceFile: () => true
      }
    )
    await saveFiles(
      matiere.fichiers
        .filter(fichier => fichier.taille < 10000000)
        .map(fichier => {
          return {
            fileurl:
              'https://api.ecoledirecte.com/v3/telechargement.awp?verbe=get',
            filename: `${matiere.dateMiseAJour} ${fichier.libelle}`,
            requestOptions: {
              method: 'POST',
              form: {
                token: currentToken,
                leTypeDeFichier: fichier.type,
                fichierId: fichier.id,
                anneeMessages: ''
              }
            }
          }
        }),
      matiereFolder,
      { requestInstance: request, contentType: true, concurrency: 8 }
    )
  }
}

async function authenticate(identifiant, motdepasse) {
  let { token, data, code } = await request.post(
    'https://api.ecoledirecte.com/v3/login.awp',
    {
      form: {
        data: JSON.stringify({ identifiant, motdepasse })
      }
    }
  )

  if (code !== 200) {
    throw new Error(errors.LOGIN_FAILED)
  }

  currentToken = token

  return data
}
